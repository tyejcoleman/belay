import { join } from 'node:path';
import { belayDir, readJSON, ensureDir, atomicWriteJSON, sanitizeText, sanitizeSlug, toEpochSec, projectKeyForCwd } from './util.mjs';
import { keyokuHome, goalSlug } from './keyoku.mjs';
import { mutateOwnState } from './state.mjs';
import { keyokuSession } from './keyoku-client.mjs';

// Loop lifecycle state: ~/.belay/loops.json (docs/DESIGN.md §3.1). Owner: agent B (round 1).
//   { "loops": { "<goalId>": { "armed": true, "paused": false, "armed_at": <epoch>,
//       "armed_by": "model"|"user"|"proposal:<id>", "session_id": "...", "cwd": "...",
//       "note": "...", "paused_at": <epoch|null>, "autonomy"?: "L0"|"L1"|"L2",
//       "canonical"?: "<key>", "supersedes"?: "<goalIdOrSlug>", "project"?: "<key>" } } }
// `project` (ADR-33, OPTIONAL, OMITTED when not derivable) is the PROJECT KEY derived from
// the arming `cwd` (util.mjs `projectKeyForCwd` — the cwd's git repo root, else the cwd
// itself) — "same folder means same project." VISIBILITY-scoping only (proposal listing /
// the portfolio steer / the statusline / `belay status`, per ADR-33): a session whose OWN
// derived project doesn't match (or subtree-contain) this loop's `project` doesn't see it on
// those surfaces. Never consulted by decideStop/decideGate for a block/allow verdict — a
// legacy entry with no `project` key falls back to today's (unscoped) behavior everywhere.
// `canonical`/`supersedes` (both OPTIONAL, OMITTED unless explicitly passed) are DISPLAY-only
// grouping hints — see `canonicalGroups` below — never consulted by any block/allow decision.
// Single source of truth stays keyoku (goals.json + focus.json): belay stores ONLY what
// keyoku has no concept of — armed-by provenance, pause, continuation counters, and (B6/
// ADR-28) the loop's declared autonomy level. No goal data is copied beyond the goalId
// key. Atomic tmp+rename 0700/0600 (util.mjs). Prune on write: goal gone from goals.json,
// or converged >7d. Pause suspends the ROPE only — the PreToolUse arrest never consults
// loops.json for the STOP hold (ADR-12), but it DOES now read this file's `autonomy` field
// to decide whether to permit an allowlisted outward action (B6) — gate.mjs is otherwise
// untouchable from here (it never mutates loops.json).
//
// `autonomy` ('L0' default/conservative | 'L1' may push non-default branches | 'L2' may push
// any branch incl. main) is a DIFFERENT axis from keyoku's own goal.autonomy field
// ('autonomous'/'suggest'/'observe' — whether belay may act on the goal at all): this one only
// narrows what an ALREADY-autonomous loop's fall-arrest gate permits outward, and only ever
// widens permission for a small allowlisted set (git push, gh pr writes) — never for the
// always-gated set (force pushes, publishes/releases, external sends, money, prod-destructive
// ops), which stays staged at EVERY level (docs/DECISIONS.md ADR-28).

const PRUNE_CONVERGED_SEC = 7 * 86400;
const INLINE_PAYLOAD_CAP = 64 * 1024; // forwarded goal_create payload cap (DESIGN.md §9)
const loopsPath = () => join(belayDir(), 'loops.json');
const now = () => Math.round(Date.now() / 1000);

/**
 * Read loops.json — hook-latency safe (one file read), degrade-to-today (ADR-4):
 * absent/malformed → { loops: {} }, which makes every new branch a no-op.
 * (Implemented in round 0: stop.mjs's round-1 `loop-paused` branch and compose.mjs
 * both consume this exact shape — the degrade contract IS the contract.)
 * @returns {{ loops: Record<string, object> }}
 */
export function readLoops() {
  const s = readJSON(loopsPath());
  if (s && typeof s === 'object' && s.loops && typeof s.loops === 'object' && !Array.isArray(s.loops)) return s;
  return { loops: {} };
}

/** goals.json, read-only (ADR-1): array of rows, or null when absent/malformed. */
const readGoalRows = () => {
  const g = readJSON(join(keyokuHome(), 'goals.json'));
  return Array.isArray(g) ? g : null;
};
const findGoalRow = (goals, ref) => (Array.isArray(goals) ? goals.find((g) => g && typeof g === 'object' && (g.id === ref || g.slug === ref)) ?? null : null);

/** Prune on write (§3.1): drop entries whose goal is gone from goals.json, or converged
 *  >7d. A null goals read (torn/absent) prunes NOTHING — never drop live loop state on
 *  unprovable evidence (ADR-4). */
function pruneLoops(loops, goals, nowSec = now()) {
  if (!Array.isArray(goals)) return loops;
  const out = {};
  for (const [goalId, e] of Object.entries(loops)) {
    const row = goals.find((g) => g && typeof g === 'object' && g.id === goalId);
    if (!row) continue; // goal gone
    if (row.status === 'converged') {
      const at = toEpochSec(row.convergedAt) ?? toEpochSec(row.updatedAt);
      if (at != null && nowSec - at > PRUNE_CONVERGED_SEC) continue; // stale-converged
    }
    out[goalId] = e;
  }
  return out;
}

function writeLoopsState(loops) {
  ensureDir(belayDir());
  atomicWriteJSON(loopsPath(), { loops });
}

/** Resolve a slug-or-id ref to a goalId: goals.json row wins; a bare loops.json key still
 *  resolves (so a loop whose goal row vanished can be stood down). Null = unknown. */
function resolveGoalId(ref, goals) {
  if (typeof ref !== 'string' || !ref) return null;
  const row = findGoalRow(goals, ref);
  if (row && typeof row.id === 'string') return row.id;
  return readLoops().loops[ref] ? ref : null;
}

const refuse = (error) => ({ ok: false, error });

/**
 * belay_loop_create — objective → armed loop, one confirmed call (DESIGN.md §2.2 T2).
 * Pipeline (ALL keyoku writes via keyoku-client child, ADR-10; each step echoed):
 *   1. resolve/create   existing `goal` → verify in goals.json (read-only);
 *                       inline → keyoku goal_create {…, autonomy:'autonomous'} verbatim
 *                       (keyoku is the single validator; cap forwarded payload ~64KB)
 *   2. autonomy         existing non-autonomous → require confirm_autonomous:true then
 *                       goal_update {autonomy:'autonomous'}, else refuse (ADR-2);
 *                       `blocked` goal → refuse with raise-maxIterations guidance
 *   3. focus            keyoku goal_focus {goal, cwd, sessionId?} — keyoku owns focus.json
 *   4. arm              loops.json entry {armed:true, paused:false, armed_by, proposal_id?};
 *                       reset (session,goal) counters in state.json (fresh loop = fresh
 *                       budget); mark proposal armed in proposals.json when given
 *   5. report           buildStatus() composition + `next` guidance string
 * Failure at any step → { ok:false, step, error } (sanitized), completed steps reported.
 *
 * @param {{ goal?: string, objective?: string, criteria?: object[], constraints?: string[],
 *          maxIterations?: number, confirm_autonomous?: boolean, scope?: 'session'|'global',
 *          session_id?: string, cwd?: string, proposal_id?: string, autonomy?: 'L0'|'L1'|'L2' }}
 *          args — belay_loop_create schema, verbatim. Default scope 'session' REQUIRES
 *          session_id (ADR-14) — auto-detected from $CLAUDE_CODE_SESSION_ID when omitted
 *          (ADR-26/B4); still refused if neither is present. `autonomy` (B6/ADR-28) is
 *          optional — omitted means the loop carries no autonomy field at all, which the
 *          PreToolUse gate treats as 'L0' (today's stage-everything behavior, unchanged).
 * @returns {Promise<object>} { ok:true, goal, status, next } | { ok:false, step, error }
 */
/** Provably-unsatisfiable criterion pairs: two assertions on the SAME probe and path that
 *  no single output can satisfy. Deliberately conservative — only contradictions that hold
 *  for EVERY possible probe output are flagged; anything weaker is the agent's
 *  baseline-assess judgment, not belay's. Returns [{criteria:[i,j], why}]. */
export function findContradictions(criteria) {
  if (!Array.isArray(criteria)) return [];
  const numv = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const oneWay = (a, b) => {
    if (a.op === 'eq' && b.op === 'eq' && !same(a.value, b.value)) return 'eq on two different values';
    if (a.op === 'eq' && b.op === 'ne' && same(a.value, b.value)) return 'eq and ne on the same value';
    if (a.op === 'contains' && b.op === 'not_contains' && same(a.value, b.value)) return 'contains and not_contains the same value';
    if (a.op === 'exists' && b.op === 'not_exists') return 'exists and not_exists';
    if (a.op === 'truthy' && b.op === 'falsy') return 'truthy and falsy';
    const av = numv(a.value);
    const bv = numv(b.value);
    const isLower = a.op === 'gt' || a.op === 'gte';
    const isUpper = b.op === 'lt' || b.op === 'lte';
    if (av != null && bv != null && isLower && isUpper && (av > bv || (av === bv && (a.op === 'gt' || b.op === 'lt')))) {
      return `disjoint numeric ranges (${a.op} ${av} vs ${b.op} ${bv})`;
    }
    return null;
  };
  const rows = criteria
    .map((c, i) => ({ i, probe: JSON.stringify(c?.probe ?? null), path: typeof c?.assert?.path === 'string' && c.assert.path ? c.assert.path : 'output', a: c?.assert }))
    .filter((r) => r.probe !== 'null' && r.a && typeof r.a.op === 'string');
  const out = [];
  for (let x = 0; x < rows.length; x++) {
    for (let y = x + 1; y < rows.length; y++) {
      if (rows[x].probe !== rows[y].probe || rows[x].path !== rows[y].path) continue;
      const why = oneWay(rows[x].a, rows[y].a) || oneWay(rows[y].a, rows[x].a);
      if (why) out.push({ criteria: [rows[x].i, rows[y].i], why });
    }
  }
  return out;
}

// ── Canonical loop grouping (sliding window: a superseded loop chain renders as ONE) ────
// A user-declared v2 of e.g. "openkakushin-recomp" superseding v1 is still logically ONE
// loop. belay never deletes loop history — every armed instance stays in loops.json (the
// sliding window) — but a DISPLAY surface (the statusline; belay_loop_list/belay status if
// they ever collapse rather than enumerate) should render one canonical group as ONE entry,
// not `×2`. Canonical key resolution, in priority order (explicit always wins over inferred):
//   1. an explicit `canonical` key stamped on the loop entry (`--canonical <key>` /
//      belay_loop_create's `canonical` arg) — a direct, human-chosen group id.
//   2. an explicit `supersedes <goalIdOrSlug>` reference (`--supersedes`) that resolves to
//      ANOTHER loop in the SAME candidate set — this loop inherits THAT loop's own resolved
//      canonical key (chain-safe: a supersedes chain of any length collapses to one group; a
//      cycle or self-reference is broken by a visited-set and falls through to rule 3).
//   3. the `-vN` / `-vN.M` STEM of this loop's own slug (`foo-recomp-v2` → `foo-recomp`) —
//      the zero-config fallback, so an ordinary version-bumped slug groups automatically with
//      no explicit wiring at all.
// A loop with neither an explicit key/reference nor a version-suffixed slug is its own
// singleton group (its stem IS its full slug) — distinct loops never accidentally merge.

const VERSION_STEM = /-v\d+(?:\.\d+)?$/i;

/** Strip a trailing `-v<N>` / `-v<N>.<M>` version suffix from a slug to derive its canonical
 *  STEM (`'foo-recomp-v2'` → `'foo-recomp'`, `'foo-recomp-v2.1'` → `'foo-recomp'`). A slug
 *  with no such suffix is already its own stem. Pure string op — never throws; a non-string
 *  input degrades to `''` (this only ever feeds a DISPLAY grouping, never a decision). */
export function stemSlug(slug) {
  if (typeof slug !== 'string' || !slug) return '';
  return slug.replace(VERSION_STEM, '') || slug;
}

/** Resolve ONE unit's canonical key against the full candidate set (priority order above).
 *  `seen` (a Set of goalIds) breaks a `supersedes` cycle/self-reference by marking "already
 *  being resolved" BEFORE following the edge, so a loop back to an in-progress node falls
 *  through to the stem fallback instead of recursing forever. Never throws. */
function resolveCanonicalKey(unit, byRef, seen) {
  if (!unit || typeof unit !== 'object') return '';
  if (typeof unit.canonical === 'string' && unit.canonical) return unit.canonical;
  if (typeof unit.supersedes === 'string' && unit.supersedes && !seen.has(unit.goalId)) {
    const target = byRef.get(unit.supersedes);
    if (target && target.goalId !== unit.goalId) {
      seen.add(unit.goalId);
      return resolveCanonicalKey(target, byRef, seen);
    }
  }
  return stemSlug(unit.slug) || (typeof unit.goalId === 'string' ? unit.goalId : '');
}

/**
 * Group a flat list of loop-unit descriptors into CANONICAL groups (see priority order
 * above). Pure, exported, independently testable — no I/O. Never throws: a malformed
 * `units` input (or malformed members within it) degrades to `[]` / a filtered set rather
 * than crashing a display surface.
 *
 * @param {Array<{goalId:string, slug:string, canonical?:string, supersedes?:string,
 *   paused?:boolean, armedAt?:number}>} units — the exact shape `statusline.mjs`'s
 *   `ownedLoopsForStatusline` already builds (one entry per armed loop this session owns).
 * @returns {Array<{ key: string, members: object[] }>}
 */
export function canonicalGroups(units) {
  if (!Array.isArray(units)) return [];
  const clean = units.filter((u) => u && typeof u === 'object' && typeof u.goalId === 'string' && u.goalId);
  const byRef = new Map();
  for (const u of clean) {
    byRef.set(u.goalId, u);
    if (typeof u.slug === 'string' && u.slug && !byRef.has(u.slug)) byRef.set(u.slug, u);
  }
  const groups = new Map();
  for (const u of clean) {
    const key = resolveCanonicalKey(u, byRef, new Set()) || u.goalId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }
  return Array.from(groups.entries()).map(([key, members]) => ({ key, members }));
}

export async function loopCreate(args = {}) {
  const steps = [];
  const fail = (step, error) => ({ ok: false, step, error, steps });
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  let sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : null;
  const ref = typeof args.goal === 'string' && args.goal ? args.goal : null;

  // 0 — scope (ADR-14): loops are SESSION-scoped by default. keyoku's focus is a global
  // singleton and a cwd-only focus scope-matches EVERY session under the subtree — an
  // unpinned default conscripted a foreign session live on 2026-07-02 (TEST-A #2). So the
  // default demands the arming session's id and pins it in goal_focus; holding the whole
  // subtree is an explicit scope:'global' opt-in, never a silent side effect.
  const scope = args.scope === undefined ? 'session' : args.scope;
  if (scope !== 'session' && scope !== 'global') {
    return fail('scope', `scope must be 'session' or 'global' (got '${sanitizeSlug(String(scope), 24)}')`);
  }
  // B4 (LOOP-BOTTLENECKS.md): auto-detect the arming session's id from the environment
  // when session-scoped and none was explicitly passed — every Claude Code session already
  // has this in-process, so requiring it as an explicit arg was pure friction. An explicit
  // session_id always wins (this branch never runs when one was passed); scope:'global'
  // never consults it, so its sessionId stays exactly what the caller passed and the
  // contradiction check right below is unaffected.
  if (scope === 'session' && !sessionId && typeof process.env.CLAUDE_CODE_SESSION_ID === 'string' && process.env.CLAUDE_CODE_SESSION_ID) {
    sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  }
  if (scope === 'session' && !sessionId) {
    return fail(
      'scope',
      "belay loops are SESSION-scoped by default: pass session_id (this session's id, from the hook payload or your transcript path) so ONLY the arming session is held by the Stop hook — or pass scope:'global' to deliberately hold EVERY session under the cwd subtree. Nothing was created or focused."
    );
  }
  if (scope === 'global' && sessionId) {
    return fail('scope', "scope:'global' and session_id are contradictory — omit session_id to hold the whole cwd subtree, or drop scope:'global' to pin the loop to that session");
  }

  // 0b — autonomy (B6/ADR-28): the declared LOOP autonomy level ('L0' conservative default |
  // 'L1' may push to non-default branches | 'L2' may push to any branch incl. main) that
  // src/gate.mjs's PreToolUse fall-arrest reads to decide whether an allowlisted outward
  // action (a plain, non-force git push; a gh pr write) is PERMITTED instead of staged.
  // Optional and REFUSED-if-invalid (never silently coerced); omitted entirely → no field is
  // written on the loops.json entry at all (see step 4 below), which is byte-identical to
  // every loop created before this change — the gate treats a missing field as 'L0'
  // (today's stage-everything behavior). This is a DIFFERENT axis from keyoku's own
  // goal.autonomy ('autonomous'/'suggest'/'observe' — whether belay may act at all); this
  // field only ever narrows what an ALREADY-autonomous loop's fall-arrest gate permits.
  if (args.autonomy !== undefined && args.autonomy !== 'L0' && args.autonomy !== 'L1' && args.autonomy !== 'L2') {
    return fail('autonomy_level', `autonomy must be one of 'L0'|'L1'|'L2' (got '${sanitizeSlug(String(args.autonomy), 24)}') — omit it to keep today's conservative default (everything outward is staged for human review)`);
  }
  const autonomyLevel = args.autonomy;

  // 0c — canonical loop identity (display grouping only — NEVER a decision input): an
  // explicit `--canonical <key>` and/or `--supersedes <goalIdOrSlug>` may be stamped on the
  // loops.json entry so a superseded goal-chain (e.g. `foo-recomp` → `foo-recomp-v2`) renders
  // as ONE canonical loop on the statusline instead of `×2` (`loops.mjs canonicalGroups`).
  // Both optional and REFUSED-if-the-wrong-type (never silently coerced, mirrors `scope`/
  // `autonomy`); omitted entirely → no key written on the entry at all — byte-identical to
  // every loop created before this change. A `-vN` slug suffix already groups automatically
  // with NEITHER flag passed (the stem fallback), so these are only needed for a chain that
  // doesn't follow that naming convention.
  if (args.canonical !== undefined && (typeof args.canonical !== 'string' || !args.canonical)) {
    return fail('canonical', 'canonical must be a non-empty string key — omit it entirely to use the automatic -vN slug-stem grouping instead');
  }
  const canonicalKey = args.canonical !== undefined ? sanitizeSlug(args.canonical, 64) : undefined;
  if (args.supersedes !== undefined && (typeof args.supersedes !== 'string' || !args.supersedes)) {
    return fail('supersedes', 'supersedes must be a non-empty string (the goal slug or id this loop replaces)');
  }
  const supersedes = args.supersedes !== undefined ? sanitizeSlug(args.supersedes, 64) : undefined;

  // 1a/2 — everything refusable is refused BEFORE any spawn (a refusal must leave
  // keyoku byte-identical, and never costs a child).
  let row = null;
  let createPayload = null;
  if (ref) {
    row = findGoalRow(readGoalRows(), ref);
    if (!row || typeof row.id !== 'string') {
      return fail('resolve', `goal not found: '${sanitizeSlug(ref)}' — omit goal and pass objective+criteria to create one inline`);
    }
    steps.push({ step: 'resolve', ok: true, goalId: row.id });
    const slug = sanitizeSlug(goalSlug(row, null));
    if (row.status === 'blocked') {
      return fail('autonomy', `goal '${slug}' is blocked (keyoku iteration budget exhausted) — raise maxIterations via keyoku goal_update directly; belay does not silently un-block`);
    }
    if (row.autonomy !== 'autonomous' && args.confirm_autonomous !== true) {
      return fail('autonomy', `goal '${slug}' autonomy is '${sanitizeSlug(String(row.autonomy), 24)}' — a loop must not silently convert a human-gated goal (ADR-2); pass confirm_autonomous:true to raise it to autonomous via keyoku`);
    }
  } else {
    if (typeof args.objective !== 'string' || !args.objective) {
      return fail('resolve', 'either goal (existing keyoku slug/id) or objective (+ criteria) is required');
    }
    createPayload = { objective: args.objective, autonomy: 'autonomous' }; // forwarded verbatim below — keyoku validates
    if (args.criteria !== undefined) createPayload.criteria = args.criteria;
    if (args.constraints !== undefined) createPayload.constraints = args.constraints;
    if (args.maxIterations !== undefined) createPayload.maxIterations = args.maxIterations;
    let size;
    try {
      size = JSON.stringify(createPayload).length;
    } catch {
      return fail('resolve', 'inline payload is not JSON-serializable');
    }
    if (size > INLINE_PAYLOAD_CAP) return fail('resolve', `inline payload is ${size} bytes — over the 64KB cap`);
  }

  // 1c — feasibility screen: provably-unsatisfiable criteria refuse BEFORE any spawn or
  // write (a loop that can never converge must be called out before work starts, not at
  // the continuation cap). Deterministic contradictions only; semantic infeasibility is
  // judged by the agent at the mandatory baseline assess (the stale-block wording directs
  // it to stand down via blocked/abandoned, which decideStop already releases).
  const impossible = findContradictions(ref ? row?.criteria : args.criteria);
  if (impossible.length) {
    const detail = impossible.map((c) => `criteria[${c.criteria[0]}] vs criteria[${c.criteria[1]}]: ${c.why}`).join('; ');
    return fail(
      'feasibility',
      `criteria are logically unsatisfiable — the same probe output can never pass both: ${sanitizeText(detail, 400)}. Nothing was created or focused. Fix or drop one side of each contradiction and retry`
    );
  }

  // 1b/2/3 — all keyoku writes on ONE short-lived registered-server child (ADR-10).
  let session;
  try {
    session = await keyokuSession();
  } catch (e) {
    return fail('spawn', sanitizeText(e?.message ?? String(e), 300));
  }
  try {
    if (createPayload) {
      let out;
      try {
        out = await session.call('goal_create', createPayload);
      } catch (e) {
        // Transport/timeout failure (NOT a keyoku validation error): keyoku persists the row
        // BEFORE it responds and a timeout SIGKILLs the child after that, so the goal MAY
        // exist despite this error (MCP-F5). Do not blind-retry — that duplicates the goal.
        return fail('create', `${sanitizeText(e?.message ?? String(e), 220)} — the goal MAY have been created despite this error; check keyoku goal_list and create only if it is absent (a blind retry risks a duplicate goal)`);
      }
      if (out?.error) return fail('create', sanitizeText(String(out.error), 400)); // keyoku's own validation verdict, verbatim content (ADR-7 form)
      row = out?.goal;
      if (!row || typeof row.id !== 'string') return fail('create', 'keyoku goal_create returned no goal row');
      steps.push({ step: 'create', ok: true, goalId: row.id, slug: sanitizeSlug(goalSlug(row, null)) });
    } else if (row.autonomy !== 'autonomous') {
      let out;
      try {
        out = await session.call('goal_update', { goal: row.id, autonomy: 'autonomous' });
      } catch (e) {
        return fail('autonomy', `${sanitizeText(e?.message ?? String(e), 220)} — the goal's autonomy MAY have been raised to autonomous despite this error (MCP-F5); check keyoku goal_get before doing anything else`);
      }
      if (out?.error) return fail('autonomy', sanitizeText(String(out.error), 400));
      row = out?.goal && typeof out.goal.id === 'string' ? out.goal : { ...row, autonomy: 'autonomous' };
      steps.push({ step: 'autonomy', ok: true, autonomy: 'autonomous' });
    }

    const focusArgs = { goal: row.id, cwd };
    if (sessionId) focusArgs.sessionId = sessionId;
    let out;
    try {
      out = await session.call('goal_focus', focusArgs);
    } catch (e) {
      // A focus that landed before the timeout means the Stop hold + fall-arrest are LIVE for
      // the pinned session even though belay reports arming failed and wrote no loops.json entry.
      return fail('focus', `${sanitizeText(e?.message ?? String(e), 200)} — the goal MAY have been focused despite this error (MCP-F5); if so the Stop hold and fall-arrest are already LIVE. Check belay_status before retrying, and belay_loop_disarm to stand down cleanly`);
    }
    if (out?.error) return fail('focus', sanitizeText(String(out.error), 400));
    steps.push({ step: 'focus', ok: true, cwd, ...(sessionId ? { session_id: sessionId } : {}) });
  } finally {
    await session.close();
  }

  // 4 — arm: belay-local provenance + a fresh continuation budget (same semantics as
  // "focused goal changed" today) + proposal marked armed. ~/.belay writes only.
  // EVERY write here is exception-guarded (refute L2-4): keyoku focus already succeeded,
  // so an FS throw (ENOSPC/EACCES on ~/.belay) must never surface as a bare -32603 that
  // hides the completed steps and invites a duplicate-goal retry (DESIGN §2.2 T2:
  // "steps already completed are reported so the model can repair").
  const nowSec = now();
  const proposalId = typeof args.proposal_id === 'string' && args.proposal_id ? args.proposal_id : null;
  // ADR-33: PROJECT KEY derived from the arming cwd — "same folder means same project."
  // OMITTED entirely when not derivable (projectKeyForCwd degrades to null only on a bad
  // `cwd`, which loopCreate never has by this point — cwd is always a non-empty string here),
  // so a loop created before this change (or in the rare non-derivable case) carries no
  // `project` key at all and every project-scoped surface falls back to today's behavior.
  const project = projectKeyForCwd(cwd);
  try {
    const state = readLoops();
    state.loops = pruneLoops(state.loops, readGoalRows(), nowSec);
    state.loops[row.id] = {
      armed: true,
      paused: false,
      armed_at: nowSec,
      armed_by: proposalId ? `proposal:${sanitizeSlug(proposalId, 64)}` : 'model',
      loop_scope: scope, // ADR-14 provenance: 'session' (pinned) | 'global' (explicit subtree hold)
      session_id: sessionId,
      cwd,
      note: null,
      paused_at: null,
      proposal_id: proposalId,
      // B6/ADR-28: field OMITTED entirely when not passed — a loop created without
      // `autonomy` has NO key here, exactly like every loop created before this change.
      ...(autonomyLevel !== undefined ? { autonomy: autonomyLevel } : {}),
      // Canonical loop identity (display grouping only): OMITTED entirely when not passed.
      ...(canonicalKey !== undefined ? { canonical: canonicalKey } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      // ADR-33: project-scoped session isolation — OMITTED when not derivable.
      ...(typeof project === 'string' && project ? { project } : {}),
    };
    writeLoopsState(state.loops);
  } catch (e) {
    return fail(
      'arm',
      `loops.json write failed (${sanitizeText(e?.message ?? String(e), 160)}) — the goal was created AND focused (see steps): the Stop hold and fall-arrest are LIVE. Do not retry the whole create (that would duplicate the goal); free ~/.belay and re-arm with belay_loop_create({goal:'${sanitizeSlug(String(row.id), 40)}',…}), or stand down via belay_loop_disarm`
    );
  }

  // Fresh-copy per-entry RMW (L1-1) — never write a stale whole-map snapshot back.
  // Reset scope (ADR-15, DESIGN §2.2 step 4's "this (session_id ?? focus-scope, goalId)
  // entry"): a session-scoped arm refunds ONLY the arming session's budget — never a
  // sibling's spent counters; a global arm refunds the focus-scope entries (every session
  // driving this goal), the "focused goal changed" fresh-budget semantics.
  let countersReset = true;
  try {
    mutateOwnState((own) => {
      let dirty = false;
      if (sessionId) {
        own.sessions[sessionId] = { goalId: row.id, continuations: 0, staleBlocked: false, updated_at: nowSec };
        dirty = true;
        // B3/ADR-25: if this session drives a portfolio, refund THIS goal's per-goal counter
        // too (re-arm = fresh budget), leaving sibling goals' counters intact — the same
        // "focused goal changed → fresh budget" semantics, per (session, goal).
        if (own.portfolios?.[sessionId] && Object.prototype.hasOwnProperty.call(own.portfolios[sessionId], row.id)) {
          delete own.portfolios[sessionId][row.id];
          dirty = true;
        }
      } else {
        for (const [sid, e] of Object.entries(own.sessions)) {
          if (e && typeof e === 'object' && e.goalId === row.id) {
            own.sessions[sid] = { ...e, continuations: 0, staleBlocked: false };
            dirty = true;
          }
        }
        // global arm refunds every portfolio's copy of this goal (all sessions driving it)
        for (const bucket of Object.values(own.portfolios ?? {})) {
          if (bucket && typeof bucket === 'object' && Object.prototype.hasOwnProperty.call(bucket, row.id)) {
            delete bucket[row.id];
            dirty = true;
          }
        }
      }
      return dirty;
    });
  } catch {
    countersReset = false; // armed-but-degraded: the loop is live, the fresh budget didn't land
  }

  let proposalMarked = false;
  if (proposalId) {
    try {
      const pPath = join(belayDir(), 'proposals.json');
      const p = readJSON(pPath);
      const hit = p && Array.isArray(p.proposals) ? p.proposals.find((x) => x && x.id === proposalId) : null;
      if (hit) {
        hit.status = 'armed';
        ensureDir(belayDir());
        atomicWriteJSON(pPath, p);
        proposalMarked = true;
      }
    } catch {
      /* armed-but-degraded: provenance bookkeeping only — reported below */
    }
  }
  steps.push({
    step: 'arm',
    ok: true,
    ...(countersReset ? {} : { counters_reset: false, degraded: 'state.json write failed — continuation counters were NOT reset; the loop is still live' }),
    ...(proposalId ? { proposal_id: proposalId, proposal_marked: proposalMarked } : {}),
    ...(autonomyLevel !== undefined ? { autonomy: autonomyLevel } : {}),
    ...(canonicalKey !== undefined ? { canonical: canonicalKey } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
  });

  // 5 — report: the same composition belay_status returns (best-effort — a compose
  // failure must not unwind an already-armed loop; the loop IS live).
  let status = null;
  try {
    status = (await import('./compose.mjs')).buildStatus({ session_id: sessionId ?? undefined, cwd });
  } catch {
    /* compose unavailable → the armed loop still reports itself */
  }
  return {
    ok: true,
    goal: {
      id: row.id,
      slug: sanitizeSlug(goalSlug(row, null)),
      status: typeof row.status === 'string' ? row.status : 'active',
      autonomy: row.autonomy,
      usedIterations: typeof row.usedIterations === 'number' ? row.usedIterations : 0,
      maxIterations: typeof row.maxIterations === 'number' ? row.maxIterations : null,
    },
    steps,
    status,
    next: 'run keyoku goal_assess to establish ground truth; the Stop hook will hold this session until convergence, budget floor, or the continuation cap',
  };
}

/**
 * belay_loop_pause — set paused:true (+ paused_at, sanitized note) on the goal's loops.json
 * entry. Writes loops.json ONLY (no spawn; keyoku untouched). The Stop hold releases
 * (`loop-paused` allow); the PreToolUse arrest stays ACTIVE while the goal remains focused
 * (ADR-12 — pausing the rope never pauses the arrest). A hand-focused goal with no armed
 * entry gets one (armed:false) — the hold applies to it, so pause must reach it too.
 * @param {{ goal: string, note?: string }} args goal = keyoku goal slug or id
 * @returns {object} { ok:true, goalId, paused:true } | { ok:false, error }
 */
export function loopPause({ goal, note } = {}) {
  const goals = readGoalRows();
  const goalId = resolveGoalId(goal, goals);
  if (!goalId) return refuse(`goal not found: '${sanitizeSlug(String(goal ?? ''))}'`);
  const state = readLoops();
  state.loops = pruneLoops(state.loops, goals);
  const e = state.loops[goalId] ?? { armed: false, paused: false, armed_at: null, armed_by: null, session_id: null, cwd: null, note: null, paused_at: null };
  e.paused = true;
  e.paused_at = now();
  if (typeof note === 'string' && note) e.note = sanitizeText(note, 200); // model/user text lands in status output (ADR-7)
  state.loops[goalId] = e;
  writeLoopsState(state.loops);
  return { ok: true, goalId, paused: true };
}

/**
 * belay_loop_resume — clear the pause flag AND set staleBlocked:false on matching
 * state.json session entries, so the first stop re-demands fresh ground truth
 * (goal_assess) — never resumes onto stale truth. Writes belay files only.
 * REFUSED when the loop is not paused (ADR-15): the stale-block refund is otherwise a
 * free mint — each pause→resume cycle may refund at most ONE extra block, keeping the
 * ADR-6 bound at max_continuations + 1 + one per explicit cycle.
 * @param {{ goal: string }} args
 * @returns {object} { ok:true, goalId, paused:false } | { ok:false, error }
 */
export function loopResume({ goal } = {}) {
  const goals = readGoalRows();
  const goalId = resolveGoalId(goal, goals);
  if (!goalId) return refuse(`goal not found: '${sanitizeSlug(String(goal ?? ''))}'`);
  const state = readLoops();
  const e = state.loops[goalId];
  if (!e) return refuse(`no loop state for goal '${sanitizeSlug(goal)}' — nothing to resume`);
  if (e.paused !== true) return refuse(`loop for goal '${sanitizeSlug(goal)}' is not paused — nothing to resume (resume refunds the one-shot stale-block, so it only follows a pause; ADR-15)`);
  state.loops = pruneLoops(state.loops, goals);
  e.paused = false;
  e.paused_at = null;
  state.loops[goalId] = e;
  writeLoopsState(state.loops);

  // Never resume onto stale truth: the one-shot stale-block spend is refunded for every
  // session driving this goal, so the first stop after resume demands a goal_assess.
  // Fresh-copy per-entry RMW (L1-1) — never write a stale whole-map snapshot back.
  mutateOwnState((own) => {
    let dirty = false;
    for (const [sid, se] of Object.entries(own.sessions)) {
      if (se && typeof se === 'object' && se.goalId === goalId && se.staleBlocked === true) {
        own.sessions[sid] = { ...se, staleBlocked: false };
        dirty = true;
      }
    }
    return dirty;
  });
  return { ok: true, goalId, paused: false };
}

/**
 * belay_loop_disarm — stand the loop fully down: keyoku-child goal_unfocus (ONLY if the
 * focused goalId matches — never blind-clears someone else's focus) + remove the
 * loops.json entry. With no focused autonomous goal, both the Stop hold and the
 * PreToolUse gate deactivate (belay returns to no-op).
 * @param {{ goal: string }} args
 * @returns {Promise<object>} { ok:true, goalId, disarmed:true } | { ok:false, step, error }
 */
export async function loopDisarm({ goal } = {}) {
  const goals = readGoalRows();
  const goalId = resolveGoalId(goal, goals);
  if (!goalId) return { ok: false, step: 'resolve', error: `goal not found: '${sanitizeSlug(String(goal ?? ''))}'` };

  const focus = readJSON(join(keyokuHome(), 'focus.json')); // read-only — belay never writes it
  let unfocused = false;
  let focusChanged = false;
  if (focus && typeof focus === 'object' && focus.goalId === goalId) {
    let session;
    try {
      session = await keyokuSession();
    } catch (e) {
      return { ok: false, step: 'spawn', error: sanitizeText(e?.message ?? String(e), 300) };
    }
    try {
      // Check-then-act guard (refute L2-1): the pre-spawn read above is ~0.5-1s stale by
      // the time the child is up, and keyoku's goal_unfocus is argument-less — a blind
      // clear of whatever focus exists at execution time. Re-read focus.json HERE, after
      // the spawn and immediately before the RPC: if a concurrent session focused a
      // DIFFERENT goal in the window (a completing belay_loop_create), skip the unfocus —
      // never blind-clear someone else's focus (their armed loop would silently lose both
      // the Stop hold and the fall-arrest). The residual race shrinks to the file-read →
      // RPC microseconds; full elimination needs a keyoku compare-and-clear API.
      const fresh = readJSON(join(keyokuHome(), 'focus.json'));
      if (fresh && typeof fresh === 'object' && fresh.goalId === goalId) {
        const out = await session.call('goal_unfocus', {});
        if (out?.error) return { ok: false, step: 'unfocus', error: sanitizeText(String(out.error), 400) };
        unfocused = true;
      } else {
        focusChanged = true;
      }
    } catch (e) {
      return { ok: false, step: 'unfocus', error: sanitizeText(e?.message ?? String(e), 300) };
    } finally {
      await session.close();
    }
  }

  const state = readLoops();
  delete state.loops[goalId];
  state.loops = pruneLoops(state.loops, goals);
  writeLoopsState(state.loops);

  // Learning flywheel (ADR-21): capture the loop's retro to belay's own store on stand-down —
  // telemetry belay alone holds (which loops thrashed/stalled/converged). Pure local write, no
  // spawn, best-effort; never blocks or fails a disarm. Feeding keyoku is the explicit
  // `belay loop retro <goal>` action, not this hot path.
  let retro = null;
  try {
    const { readConfig } = await import('./util.mjs');
    const { buildRetro, writeRetro, recordRetro } = await import('./retro.mjs');
    if (readConfig().cfg.retro_auto_push === true) {
      retro = (await recordRetro(goalId, { push: true })).retro; // opt-in: also file into keyoku (spawns)
    } else {
      retro = buildRetro(goalId); // default: local capture only, no spawn
      if (retro) writeRetro(retro);
    }
  } catch {
    /* retro is telemetry — never blocks a disarm */
  }

  const res = { ok: true, goalId, disarmed: true, unfocused, ...(retro ? { retro } : {}) };
  if (focusChanged) {
    res.note = "focus moved to another goal between resolve and unfocus — left untouched (belay never blind-clears someone else's focus); this goal's arm state was still cleared";
  }
  return res;
}
