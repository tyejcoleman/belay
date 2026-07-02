// Self-proposed loops: scan state files for loop-worthy signals → persist proposal
// objects → surface (SessionStart / belay_propose). Proposals NEVER act (ADR-11): arming
// happens only via an explicit belay_loop_create call. Design: docs/DESIGN.md §4.
// Owner: agent C (round 1).
//
// ~/.belay/proposals.json (§3.1):
//   { "proposals": [ { "id": "<sha256-12 of kind+key-fields>",
//       "kind": "resume-ready|unfocused-autonomous|stale-converged|budget-reset|keyoku-ripe",
//       "summary": "<sanitized ≤200>", "evidence": { …exact figures + source path },
//       "suggested_create": { …belay_loop_create args }, "created_at": <epoch>,
//       "status": "open|dismissed|armed", "surfaced_count": n } ] }
// Content-hash ids: a persisting signal reproduces the same id, so dismissal sticks until
// the signal itself changes. Prune: dismissed/armed >7d; open >48h re-derived on next scan.
//
// Signals (§4.1, ALL pure file reads — SessionStart-latency safe, <50ms):
//   S1 resume-ready          ~/.tokenroom/resume.json valid + now >= resume_at
//                            (suggested inline goal marked needs_probes:true — belay
//                             never invents machine checks)
//   S2 unfocused-autonomous  goals.json: active + autonomous + not focused
//   S3 stale-converged       converged + lastAssessedAt older than cfg.stale_converged_days
//                            → suggests a DIRECT keyoku goal_assess, NOT a loop
//   S4 budget-reset          state.json five_hour crossed resets_at (<30min ago) or
//                            left_pct >= 85 with a paused loop / S1 open — an AMPLIFIER
//                            attached to those proposals, not standalone
//   S5 keyoku-ripe           ~/.keyoku/ripe.json fresh (<24h) suggestions, deduped against
//                            surfaced.json — advisory, sanitized (cross-goal data, ADR-7)

const notImplemented = (fn) => Object.assign(new Error(`belay: ${fn} not implemented (round-0 stub — see docs/DESIGN.md)`), { code: 'ERR_NOT_IMPLEMENTED' });

/**
 * Run the S1–S5 scan, merge with (and persist to) proposals.json — dedupe by content-hash
 * id, keep sticky dismissals, prune. Returns the full current proposal list (open first).
 * Read-only over keyoku/tokenroom files; writes only ~/.belay/proposals.json. Never
 * throws on absent/malformed inputs (ADR-4) — a bad source file just yields no signal.
 * Master switch: cfg.proposals_enabled (false → { proposals: [] }, no writes).
 * @param {{ nowSec?: number }} [opts] injectable clock for tests
 * @returns {{ proposals: object[] }}
 */
export function scan({ nowSec } = {}) {
  throw notImplemented('scan');
}

/**
 * Dismiss one proposal by id (status:'dismissed' in proposals.json). Sticky: the same
 * content-hash id won't re-surface until the underlying signal changes.
 * @param {string} id
 * @returns {object} { ok:true, id } | { ok:false, error }
 */
export function dismiss(id) {
  throw notImplemented('dismiss');
}
