// Shared composition — `belay status` (CLI) and `belay_status`/`belay_loop_list` (MCP)
// all render from these, so CLI and MCP can never drift (docs/DESIGN.md §2.2 T1/T3, §2.3
// — same discipline as stack.mjs sharing between bundle/doctor). Owner: agent A (round 1);
// agent D imports read-only for status.mjs/doctor.mjs rendering.
//
// ROUND-0 CONTRACT (FROZEN): every response field maps to an exact file source (ADR-9);
// nothing is estimated by belay. Read-only — no writes, no spawns, hook-latency safe.

const notImplemented = (fn) => Object.assign(new Error(`belay: ${fn} not implemented (round-0 stub — see docs/DESIGN.md)`), { code: 'ERR_NOT_IMPLEMENTED' });

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
 * All sibling-derived strings sanitized (ADR-7) before they land in the response.
 *
 * @param {{ session_id?: string, cwd?: string }} [opts]
 * @returns {{ stack: object, budget: object, goal: object|null, loop: object|null,
 *            counters: object, verdict: object, proposals_open: number }}
 */
export function buildStatus({ session_id, cwd } = {}) {
  throw notImplemented('buildStatus');
}

/**
 * All loop-relevant goals composed with belay's arm/pause metadata (DESIGN.md §2.2 T3):
 * goals.json rows (status/autonomy/lastAssessedAt/convergedAt) × focus.json × loops.json
 * × state.json counters. Read-only, no spawn.
 *
 * @returns {{ loops: Array<{ goalId: string, slug: string, status: string,
 *            autonomy: string, focused: boolean, armed: boolean, paused: boolean,
 *            armed_by?: string, usedIterations?: number, maxIterations?: number,
 *            lastAssessedAt?: string, convergedAt?: string, stale_converged?: boolean }> }}
 */
export function buildLoopList() {
  throw notImplemented('buildLoopList');
}
