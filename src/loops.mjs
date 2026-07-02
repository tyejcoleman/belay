import { join } from 'node:path';
import { belayDir, readJSON } from './util.mjs';

// Loop lifecycle state: ~/.belay/loops.json (docs/DESIGN.md §3.1). Owner: agent B (round 1).
//   { "loops": { "<goalId>": { "armed": true, "paused": false, "armed_at": <epoch>,
//       "armed_by": "model"|"user"|"proposal:<id>", "session_id": "...", "cwd": "...",
//       "note": "...", "paused_at": <epoch|null> } } }
// Single source of truth stays keyoku (goals.json + focus.json): belay stores ONLY what
// keyoku has no concept of — armed-by provenance, pause, continuation counters. No goal
// data is copied beyond the goalId key. Atomic tmp+rename 0700/0600 (util.mjs). Prune on
// write: goal gone from goals.json, or converged >7d. Pause suspends the ROPE only — the
// PreToolUse arrest never consults loops.json (ADR-12); gate.mjs is untouchable from here.

const notImplemented = (fn) => Object.assign(new Error(`belay: ${fn} not implemented (round-0 stub — see docs/DESIGN.md)`), { code: 'ERR_NOT_IMPLEMENTED' });

const loopsPath = () => join(belayDir(), 'loops.json');

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
 *          maxIterations?: number, confirm_autonomous?: boolean, session_id?: string,
 *          cwd?: string, proposal_id?: string }} args — belay_loop_create schema, verbatim
 * @returns {Promise<object>} { ok:true, goal, status, next } | { ok:false, step, error }
 */
export async function loopCreate(args = {}) {
  throw notImplemented('loopCreate');
}

/**
 * belay_loop_pause — set paused:true (+ paused_at, sanitized note) on the goal's loops.json
 * entry. Writes loops.json ONLY (no spawn; keyoku untouched). The Stop hold releases
 * (`loop-paused` allow); the PreToolUse arrest stays ACTIVE while the goal remains focused
 * (ADR-12 — pausing the rope never pauses the arrest).
 * @param {{ goal: string, note?: string }} args goal = keyoku goal slug or id
 * @returns {object} { ok:true, goalId, paused:true } | { ok:false, error }
 */
export function loopPause({ goal, note } = {}) {
  throw notImplemented('loopPause');
}

/**
 * belay_loop_resume — clear the pause flag AND set staleBlocked:false on matching
 * state.json session entries, so the first stop re-demands fresh ground truth
 * (goal_assess) — never resumes onto stale truth. Writes belay files only.
 * @param {{ goal: string }} args
 * @returns {object} { ok:true, goalId, paused:false } | { ok:false, error }
 */
export function loopResume({ goal } = {}) {
  throw notImplemented('loopResume');
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
  throw notImplemented('loopDisarm');
}
