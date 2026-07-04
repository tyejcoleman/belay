import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, readConfig, toEpochSec, sanitizeText, sanitizeSlug, capReason, belayDir, tokenroomDir } from './util.mjs';
import { keyokuHome, readKeyoku, goalSlug, unmetDetail } from './keyoku.mjs';
import { readBudget } from './budget.mjs';
import { readOwnState, sessionEntry } from './state.mjs';
import { readLoops } from './loops.mjs';
import { pendingSummary } from './pending.mjs';
import { decideStop, budgetLine } from './stop.mjs';
import { keyokuStatus, tokenroomInstalled, belayHooksStatus, claudeJsonPath } from './stack.mjs';
import { configDir, MARK } from './install.mjs';

// Shared composition — `belay status` (CLI) and `belay_status`/`belay_loop_list` (MCP)
// all render from these, so CLI and MCP can never drift (docs/DESIGN.md §2.2 T1/T3, §2.3
// — same discipline as stack.mjs sharing between bundle/doctor). Owner: agent A (round 1);
// agent D imports read-only for status.mjs/doctor.mjs rendering.
//
// ROUND-0 CONTRACT (FROZEN): every response field maps to an exact file source (ADR-9);
// nothing is estimated by belay. Read-only — no writes, no spawns, hook-latency safe.
//
// Round-1 note on the stack block: DESIGN.md's T1 table names stackHealth() as the
// source, but stackHealth → resolveTokenroom spawns `which` — forbidden by the no-spawn
// line above. We compose from stackHealth's own exported building blocks instead
// (keyokuStatus / tokenroomInstalled / belayHooksStatus — identical reads, zero spawns).
// The one delta: tokenroom.present no longer counts a PATH-resolvable-but-never-installed
// binary; ~/.tokenroom or an installed hook still counts (the states that carry data).

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Array-count caps for the MCP surface (MCP-F4): the Stop hook already caps the JOINED unmet
// text (capReason 1.2KB), but buildStatus returned the same file-controlled arrays uncapped —
// a torn/hostile observations tail with 100k unmet ids, or a goal row with thousands of
// constraints, floods megabytes of JSON into the model's context. Cap the COUNT here too.
const MAX_LIST = 50;
const MAX_ROWS = 200;
/** Cap an array's length, appending a truncation marker; passes null/non-arrays through. */
function capList(arr, max = MAX_LIST) {
  if (!Array.isArray(arr) || arr.length <= max) return arr;
  return [...arr.slice(0, max), `…(${arr.length - max} more truncated)`];
}

// ── Budget attribution (tokenroom ADR-24 mirror — DESIGN.md §2.2 T1) ─────────────────
// MCP calls carry no session id. The sessions.json map tells us which ACCOUNTS were
// active in the last ~10min: exactly one → use it (via readBudget's own per-account
// routing, not the top-level pointer a concurrent account may have overwritten); two or
// more with no session_id → quota figures are WITHHELD with an explicit `attribution`
// note — wrong-account numbers are worse than none. `alt` survives a withhold: it names
// its own profile, so it is never mis-attributed.

const ACTIVE_WINDOW_SEC = 10 * 60;
const AMBIGUOUS =
  "ambiguous — quota withheld (2 or more accounts were active in the last 10 minutes and no session_id was given; pass this session's id to belay_status for exact attribution — wrong-account numbers are worse than none)";

/** Active accounts from sessions.json: key → the freshest {sid, at} seen for it. */
function activeAccounts(nowSec) {
  const map = readJSON(join(tokenroomDir(), 'sessions.json'));
  const byKey = new Map();
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [sid, e] of Object.entries(map)) {
      if (!e || typeof e !== 'object' || typeof e.key !== 'string' || !e.key) continue;
      const at = toEpochSec(e.at);
      if (at == null || nowSec - at > ACTIVE_WINDOW_SEC) continue;
      const prev = byKey.get(e.key);
      if (!prev || at > prev.at) byKey.set(e.key, { sid, at });
    }
  }
  return byKey;
}

function attributedBudget(sessionId, nowSec) {
  if (sessionId) {
    const b = readBudget(sessionId, nowSec);
    return {
      ...b,
      attribution: b.withheld
        ? 'unmapped session on a multi-account machine — quota withheld (the top-level pointer is last-writer-wins across accounts; wrong-account numbers are worse than none); figures return once tokenroom maps this session'
        : null,
    };
  }
  const active = activeAccounts(nowSec);
  if (active.size >= 2) {
    const b = readBudget(undefined, nowSec); // for `alt` only — every quota figure is withheld
    return { known: false, left_pct: null, resets_at: null, est_tokens_left: null, stale: false, last_known_left: null, alt: b.alt, withheld: true, attribution: AMBIGUOUS };
  }
  if (active.size === 1) return { ...readBudget(active.values().next().value.sid, nowSec), attribution: null };
  return { ...readBudget(undefined, nowSec), attribution: null }; // no active accounts → legacy top-level pointer
}

// ── Stack block (read-only, spawn-free — see round-1 note above) ─────────────────────

/** Is a MARK-owned hook registered for this settings.json event? (belayHooksStatus only
 *  covers Stop/PreToolUse; SessionStart lands in round 1 via agent C's installer.) */
function hookRegistered(dir, event) {
  const s = readJSON(join(dir, 'settings.json'));
  const entries = Array.isArray(s?.hooks?.[event]) ? s.hooks[event] : [];
  return entries.some((m) => (m?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.includes(MARK)));
}

/** Is a belay MCP server registered in ~/.claude.json (top level or any project block)? */
function belayMcpRegistered() {
  const cj = readJSON(claudeJsonPath());
  const names = [];
  if (cj && typeof cj === 'object') {
    if (cj.mcpServers && typeof cj.mcpServers === 'object') names.push(...Object.keys(cj.mcpServers));
    if (cj.projects && typeof cj.projects === 'object') {
      for (const p of Object.values(cj.projects)) {
        if (p && typeof p === 'object' && p.mcpServers && typeof p.mcpServers === 'object') names.push(...Object.keys(p.mcpServers));
      }
    }
  }
  return names.some((n) => /belay/i.test(n));
}

function stackView(dir) {
  const k = keyokuStatus();
  const installed = tokenroomInstalled(dir);
  const hooks = belayHooksStatus(dir);
  return {
    tokenroom: { present: installed || existsSync(tokenroomDir()), installed },
    keyoku: { registered: k.registered, version: k.version, inRange: k.inRange },
    belay: { stop: hooks.stop, preToolUse: hooks.preToolUse, sessionStart: hookRegistered(dir, 'SessionStart'), mcpRegistered: belayMcpRegistered() },
  };
}

/**
 * The whole loop brain in one composed object (DESIGN.md §2.2 T1 field table):
 *   stack     ← stack.mjs stackHealth()        (settings.json, ~/.claude.json, keyoku pkg walk)
 *   budget    ← budget.mjs readBudget(session_id) + `attribution` per tokenroom ADR-24
 *               (≥2 accounts active in last 10min and no session_id → withhold quota,
 *                explain in `attribution`; wrong-account numbers are worse than none)
 *   goal      ← keyoku.mjs readKeyoku() (focus.json + goals.json row), `unmet` via
 *               unmetDetail (null = no readable assessment), `assessment_age_min` from
 *               max(lastAssessedAt, obs.at) — same freshness rule as decideStop
 *   loop      ← ~/.belay/loops.json entry: { armed, paused, armed_at, armed_by, proposal_id }
 *   counters  ← ~/.belay/state.json via sessionEntry(): { continuations, max, staleBlocked }
 *   verdict   ← decideStop(payload, k, budget, cfg, entry) — the SAME pure function the
 *               Stop hook runs: { action, kind, reason? }
 *   proposals_open ← ~/.belay/proposals.json (count only)
 *   pending   ← ~/.belay/pending.json: { count, classes } (ADR-16 — presentation
 *               metadata only; absent file → { count: 0, classes: [] })
 * All sibling-derived strings sanitized (ADR-7) before they land in the response.
 *
 * Scope defaults: cwd falls back to the server process cwd (the frozen T1 schema text);
 * session_id falls back to the focus's own sessionId pin when one exists (a session-
 * pinned focus is judged as that session would be — the status.mjs posture), else the
 * ADR-24 attribution rule above decides whose budget we may report.
 *
 * @param {{ session_id?: string, cwd?: string }} [opts]
 * @returns {{ stack: object, budget: object, goal: object|null, loop: object|null,
 *            counters: object, verdict: object, proposals_open: number,
 *            pending: { count: number, classes: string[] } }}
 */
export function buildStatus({ session_id, cwd } = {}) {
  const nowSec = Date.now() / 1000;
  const { cfg } = readConfig();
  const dir = configDir([]);

  const focus = readJSON(join(keyokuHome(), 'focus.json'));
  const focusSession = focus && typeof focus === 'object' && typeof focus.sessionId === 'string' && focus.sessionId ? focus.sessionId : null;
  const sessionId = typeof session_id === 'string' && session_id ? session_id : focusSession;
  const effCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();

  const budget = attributedBudget(sessionId, nowSec);
  const k = readKeyoku({ sessionId: sessionId ?? 'status-probe', cwd: effCwd });
  const own = readOwnState();
  // No fabrication (refute L4-2): counters are keyed per (session, goal) in state.json.
  // With no session_id and no focus pin there is NO row to read — sessionEntry would
  // return the zero-history DEFAULT for a phantom key, and 0/25 would be reported as if
  // file-sourced (opposite verdicts from the real driving session's hook were reproduced).
  // So: figures are withheld as `unattributed`, and the verdict is explicitly marked as
  // zero-history — the same posture the budget block already takes (ADR-24 mirror).
  const entry = sessionEntry(own, sessionId ?? 'status-probe', k.goal?.id ?? null);
  // The SAME pure function the Stop hook runs — read-only here: the mutated counter
  // entry decideStop hands back is deliberately NOT persisted (like status.mjs).
  const d = decideStop({ session_id: sessionId ?? 'status-probe', cwd: effCwd, stop_hook_active: false }, k, budget, cfg, entry);

  let goal = null;
  if (k.goal) {
    const g = k.goal;
    const freshCandidates = [toEpochSec(g.lastAssessedAt), toEpochSec(k.obs?.at)].filter((t) => t != null);
    const freshAt = freshCandidates.length ? Math.max(...freshCandidates) : null;
    goal = {
      id: g.id,
      slug: sanitizeSlug(goalSlug(g, k.focus)),
      status: sanitizeSlug(typeof g.status === 'string' ? g.status : 'unknown', 32),
      autonomy: sanitizeSlug(typeof g.autonomy === 'string' ? g.autonomy : 'unknown', 32),
      usedIterations: num(g.usedIterations),
      maxIterations: num(g.maxIterations),
      lastAssessedAt: typeof g.lastAssessedAt === 'string' ? g.lastAssessedAt : null,
      constraints: capList(Array.isArray(g.constraints) ? g.constraints.filter((c) => typeof c === 'string' && c).map((c) => sanitizeText(c, 200)) : []),
      unmet: capList(unmetDetail(g, k.obs)), // per-item sanitized in keyoku.mjs; null = no readable assessment; count-capped (MCP-F4)
      assessment_age_min: freshAt == null ? null : Math.max(0, Math.round((nowSec - freshAt) / 60)),
    };
  }

  const le = k.goal ? readLoops().loops[k.goal.id] : null;
  const loop =
    le && typeof le === 'object'
      ? {
          armed: le.armed === true,
          paused: le.paused === true,
          armed_at: num(le.armed_at),
          armed_by: typeof le.armed_by === 'string' ? sanitizeText(le.armed_by, 64) : null,
          scope: le.loop_scope === 'session' || le.loop_scope === 'global' ? le.loop_scope : null, // ADR-14 provenance
          proposal_id: typeof le.proposal_id === 'string' ? sanitizeSlug(le.proposal_id, 32) : null,
        }
      : null;

  const props = readJSON(join(belayDir(), 'proposals.json'));
  const proposals_open = props && Array.isArray(props.proposals) ? props.proposals.filter((p) => p && typeof p === 'object' && p.status === 'open').length : 0;

  const verdict = { action: d.action, kind: d.kind };
  if (d.reason) verdict.reason = d.reason;
  if (d.note) verdict.note = d.note;

  let counters;
  if (sessionId || !k.goal) {
    // With no matched goal the verdict is session-independent and the zero counters are
    // the true value for EVERY session (entries are keyed per goal) — nothing to withhold.
    counters = { continuations: entry.continuations, max: cfg.max_continuations, staleBlocked: entry.staleBlocked };
  } else {
    counters = {
      continuations: null,
      max: cfg.max_continuations,
      staleBlocked: null,
      attribution:
        'unattributed — no session_id was given and the focus has no sessionId pin; counters are per-(session, goal) rows in ~/.belay/state.json, so no figure can be truthfully reported (pass this session’s id for exact counters and the exact hook verdict)',
    };
    verdict.attribution =
      "computed with ZERO per-session history (no session_id) — the driving session's real verdict can differ: its continuation and stale-block spends are unknown here";
  }

  return {
    stack: stackView(dir),
    budget,
    goal,
    loop,
    counters,
    verdict,
    proposals_open,
    pending: pendingSummary(),
  };
}

/**
 * Compaction re-briefing (ADR-21): a one-block summary of the loop a session is mid-flight on,
 * for SessionStart to re-inject after a compaction/resume/startup. SessionStart previously
 * surfaced ONLY proposals, and a mid-flight loop is by definition not a proposal — so a
 * compacted session restarted BLIND, rediscovering its goal only when it next tried to stop.
 * All data is a pure file read (readKeyoku + state + budget), reusing the Stop hook's own
 * freshness and budget wording. Returns a sanitized/capped string, or null when there is no
 * scope-matched focused active autonomous loop to brief (incl. a paused one — not being driven).
 *
 * @param {{ session_id?: string, cwd?: string }} [opts]
 * @returns {string|null}
 */
export function buildLoopBriefing({ session_id, cwd } = {}) {
  const { cfg } = readConfig();
  const k = readKeyoku({ sessionId: session_id, cwd });
  if (!k.present || k.paused || !k.focus || !k.matched || !k.goal) return null;
  const g = k.goal;
  if (g.status !== 'active' || g.autonomy !== 'autonomous') return null;
  const le = readLoops().loops[g.id];
  if (le && typeof le === 'object' && le.paused === true) return null; // paused = rope released, nothing to resume-brief

  const slug = sanitizeSlug(goalSlug(g, k.focus));
  const parts = [`[belay] you are MID-LOOP on autonomous goal '${slug}' (a live convergence loop — likely from before a context compaction)`];
  if (typeof g.objective === 'string' && g.objective) parts.push(`objective: ${sanitizeText(g.objective, 200)}`);
  const unmet = unmetDetail(g, k.obs);
  if (Array.isArray(unmet) && unmet.length) parts.push(`unmet: ${capReason(unmet.join('; '), 600)}`);
  else if (unmet == null) parts.push('no readable assessment yet');
  const cons = Array.isArray(g.constraints) ? g.constraints.filter((c) => typeof c === 'string' && c).slice(0, 5).map((c) => sanitizeText(c, 120)) : [];
  if (cons.length) parts.push(`constraints: ${cons.join('; ')}`);
  const entry = sessionEntry(readOwnState(), session_id ?? 'status-probe', g.id);
  parts.push(`continuations ${entry.continuations}/${cfg.max_continuations}`);
  const bl = budgetLine(readBudget(session_id, Date.now() / 1000), cfg).trim();
  if (bl) parts.push(bl.replace(/\.$/, ''));
  parts.push('run goal_assess to re-establish ground truth before continuing (never claim convergence without it)');
  return capReason(parts.join(' · '), 1200);
}

/**
 * All loop-relevant goals composed with belay's arm/pause metadata (DESIGN.md §2.2 T3):
 * goals.json rows (status/autonomy/lastAssessedAt/convergedAt) × focus.json × loops.json
 * × state.json counters. Read-only, no spawn.
 *
 * A row is loop-relevant when it is the focused goal, an active autonomous goal
 * (armable), carries a loops.json entry (armed/paused), or is a stale-converged goal
 * (re-assess candidate per cfg.stale_converged_days). `continuations` is the additive
 * counters composition: the sum of this goal's per-session spends from state.json.
 * Order: focused → armed → active autonomous → stale-converged, then by slug.
 *
 * @returns {{ loops: Array<{ goalId: string, slug: string, status: string,
 *            autonomy: string, focused: boolean, armed: boolean, paused: boolean,
 *            armed_by?: string, usedIterations?: number, maxIterations?: number,
 *            lastAssessedAt?: string, convergedAt?: string, stale_converged?: boolean }> }}
 */
export function buildLoopList() {
  const nowSec = Date.now() / 1000;
  const { cfg } = readConfig();
  const home = keyokuHome();
  const goals = readJSON(join(home, 'goals.json'));
  const rows = Array.isArray(goals) ? goals.filter((g) => g && typeof g === 'object' && typeof g.id === 'string' && g.id) : [];
  const focus = readJSON(join(home, 'focus.json'));
  const focusId = focus && typeof focus === 'object' && typeof focus.goalId === 'string' ? focus.goalId : null;
  const loops = readLoops().loops;
  const own = readOwnState();

  const out = [];
  for (const g of rows) {
    const le = loops[g.id] && typeof loops[g.id] === 'object' ? loops[g.id] : null;
    const focused = g.id === focusId;
    const armable = g.status === 'active' && g.autonomy === 'autonomous';
    // S3 predicate (DESIGN.md §4.1): converged, last ground truth older than the config
    // window. Never re-assessed at all → convergedAt stands in; neither → stale.
    const assessedAt = toEpochSec(g.lastAssessedAt) ?? toEpochSec(g.convergedAt);
    const staleConverged = g.status === 'converged' && (assessedAt == null || nowSec - assessedAt > cfg.stale_converged_days * 86400);
    if (!focused && !armable && !le && !staleConverged) continue;

    let continuations = 0;
    for (const e of Object.values(own.sessions)) {
      if (e && typeof e === 'object' && e.goalId === g.id && num(e.continuations) != null) continuations += e.continuations;
    }

    const row = {
      goalId: g.id,
      slug: sanitizeSlug(goalSlug(g, focused ? focus : null)),
      status: sanitizeSlug(typeof g.status === 'string' ? g.status : 'unknown', 32),
      autonomy: sanitizeSlug(typeof g.autonomy === 'string' ? g.autonomy : 'unknown', 32),
      focused,
      armed: le?.armed === true,
      paused: le?.paused === true,
      continuations,
    };
    if (typeof le?.armed_by === 'string') row.armed_by = sanitizeText(le.armed_by, 64);
    if (num(g.usedIterations) != null) row.usedIterations = g.usedIterations;
    if (num(g.maxIterations) != null) row.maxIterations = g.maxIterations;
    if (typeof g.lastAssessedAt === 'string') row.lastAssessedAt = g.lastAssessedAt;
    if (typeof g.convergedAt === 'string') row.convergedAt = g.convergedAt;
    if (g.status === 'converged') row.stale_converged = staleConverged;
    out.push(row);
  }

  const rank = (r) => (r.focused ? 0 : r.armed ? 1 : r.status === 'active' ? 2 : 3);
  out.sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
  // Bound the row count (MCP-F4): a keyoku with thousands of goals must not flood context.
  if (out.length > MAX_ROWS) return { loops: out.slice(0, MAX_ROWS), truncated: out.length - MAX_ROWS };
  return { loops: out };
}
