import { join } from 'node:path';
import { belayDir, readJSON, ensureDir, atomicWriteJSON, sanitizeText, sanitizeSlug, toEpochSec } from './util.mjs';
import { keyokuHome, goalSlug } from './keyoku.mjs';
import { mutateOwnState } from './state.mjs';
import { keyokuSession } from './keyoku-client.mjs';

// Loop lifecycle state: ~/.belay/loops.json (docs/DESIGN.md §3.1). Owner: agent B (round 1).
//   { "loops": { "<goalId>": { "armed": true, "paused": false, "armed_at": <epoch>,
//       "armed_by": "model"|"user"|"proposal:<id>", "session_id": "...", "cwd": "...",
//       "note": "...", "paused_at": <epoch|null> } } }
// Single source of truth stays keyoku (goals.json + focus.json): belay stores ONLY what
// keyoku has no concept of — armed-by provenance, pause, continuation counters. No goal
// data is copied beyond the goalId key. Atomic tmp+rename 0700/0600 (util.mjs). Prune on
// write: goal gone from goals.json, or converged >7d. Pause suspends the ROPE only — the
// PreToolUse arrest never consults loops.json (ADR-12); gate.mjs is untouchable from here.

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
 *          session_id?: string, cwd?: string, proposal_id?: string }} args — belay_loop_create
 *          schema, verbatim. Default scope 'session' REQUIRES session_id (ADR-14).
 * @returns {Promise<object>} { ok:true, goal, status, next } | { ok:false, step, error }
 */
export async function loopCreate(args = {}) {
  const steps = [];
  const fail = (step, error) => ({ ok: false, step, error, steps });
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : null;
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
  if (scope === 'session' && !sessionId) {
    return fail(
      'scope',
      "belay loops are SESSION-scoped by default: pass session_id (this session's id, from the hook payload or your transcript path) so ONLY the arming session is held by the Stop hook — or pass scope:'global' to deliberately hold EVERY session under the cwd subtree. Nothing was created or focused."
    );
  }
  if (scope === 'global' && sessionId) {
    return fail('scope', "scope:'global' and session_id are contradictory — omit session_id to hold the whole cwd subtree, or drop scope:'global' to pin the loop to that session");
  }

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
        return fail('create', sanitizeText(e?.message ?? String(e), 300));
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
        return fail('autonomy', sanitizeText(e?.message ?? String(e), 300));
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
      return fail('focus', sanitizeText(e?.message ?? String(e), 300));
    }
    if (out?.error) return fail('focus', sanitizeText(String(out.error), 400));
    steps.push({ step: 'focus', ok: true, cwd, ...(sessionId ? { session_id: sessionId } : {}) });
  } finally {
    await session.close();
  }

  // 4 — arm: belay-local provenance + a fresh continuation budget (same semantics as
  // "focused goal changed" today) + proposal marked armed. ~/.belay writes only.
  const nowSec = now();
  const proposalId = typeof args.proposal_id === 'string' && args.proposal_id ? args.proposal_id : null;
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
  };
  writeLoopsState(state.loops);

  // Fresh-copy per-entry RMW (L1-1) — never write a stale whole-map snapshot back.
  mutateOwnState((own) => {
    let dirty = false;
    for (const [sid, e] of Object.entries(own.sessions)) {
      if (e && typeof e === 'object' && e.goalId === row.id) {
        own.sessions[sid] = { ...e, continuations: 0, staleBlocked: false };
        dirty = true;
      }
    }
    if (sessionId) {
      own.sessions[sessionId] = { goalId: row.id, continuations: 0, staleBlocked: false, updated_at: nowSec };
      dirty = true;
    }
    return dirty;
  });

  let proposalMarked = false;
  if (proposalId) {
    const pPath = join(belayDir(), 'proposals.json');
    const p = readJSON(pPath);
    const hit = p && Array.isArray(p.proposals) ? p.proposals.find((x) => x && x.id === proposalId) : null;
    if (hit) {
      hit.status = 'armed';
      ensureDir(belayDir());
      atomicWriteJSON(pPath, p);
      proposalMarked = true;
    }
  }
  steps.push({ step: 'arm', ok: true, ...(proposalId ? { proposal_id: proposalId, proposal_marked: proposalMarked } : {}) });

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
  const res = { ok: true, goalId, disarmed: true, unfocused };
  if (focusChanged) {
    res.note = "focus moved to another goal between resolve and unfocus — left untouched (belay never blind-clears someone else's focus); this goal's arm state was still cleared";
  }
  return res;
}
