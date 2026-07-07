import { join } from 'node:path';
import { belayDir, ensureDir, atomicWriteJSON, readJSON } from './util.mjs';

// Belay's facilitator-set "awaiting async work" marker (B7, ADR-24):
//   ~/.belay/await.json — { sessions: { <session_id>: { at } } }
// The facilitator sets it (`belay await on`) when it dispatches a background sub-agent /
// Workflow and clears it (`belay await off`) when the harness auto-resumes it on worker
// completion. While set for a session, belay's Stop hook ALLOWS that session's stop, so the
// loop advances on the harness's completion event instead of a forced spin (wasted tokens).
//
// SESSION-SCOPED by construction: every op is keyed by the session_id passed in (the Stop
// payload's own session_id on the read path), so a marker set in session A can never release
// session B's loop. This is an ALLOW-ONLY signal — nothing here ever forces a continuation —
// so ADR-6 termination is untouched. Entries self-prune after 7 days, exactly like state.mjs;
// a marker a crashed facilitator forgot to clear only ever ALLOWS stops (the safe direction)
// and is pruned on the next write. Reads are never-crash (ADR-4): any failure → not awaiting.

const PRUNE_SEC = 7 * 86400;
const awaitPath = () => join(belayDir(), 'await.json');

function readAwaitState() {
  const s = readJSON(awaitPath());
  if (s && typeof s === 'object' && s.sessions && typeof s.sessions === 'object' && !Array.isArray(s.sessions)) return s;
  return { sessions: {} };
}

function prune(state, nowSec) {
  for (const k of Object.keys(state.sessions)) {
    const e = state.sessions[k];
    if (!e || typeof e !== 'object' || nowSec - (typeof e.at === 'number' ? e.at : 0) > PRUNE_SEC) delete state.sessions[k];
  }
}

/** True iff a live await marker is set for THIS session_id. Never throws — any read/parse
 *  failure or a missing/garbage marker degrades to false (the normal steering path, ADR-4). */
export function isAwaiting(sessionId) {
  try {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const e = readAwaitState().sessions[sessionId];
    return e != null && typeof e === 'object' && typeof e.at === 'number' && Number.isFinite(e.at) && e.at > 0;
  } catch {
    return false;
  }
}

/** Set the await marker for one session (idempotent). Read-fresh → prune → merge → atomic
 *  write, the same last-writer-wins-per-entry discipline as state.mjs saveSessionEntry. */
export function setAwait(sessionId, nowSec = Date.now() / 1000) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('setAwait: a session_id is required (the marker is session-scoped)');
  const now = Math.round(nowSec);
  const fresh = readAwaitState();
  prune(fresh, now);
  fresh.sessions[sessionId] = { at: now };
  ensureDir(belayDir());
  atomicWriteJSON(awaitPath(), fresh);
  return true;
}

/** Clear the await marker for one session. Returns whether one was present. */
export function clearAwait(sessionId, nowSec = Date.now() / 1000) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('clearAwait: a session_id is required (the marker is session-scoped)');
  const fresh = readAwaitState();
  prune(fresh, Math.round(nowSec));
  const had = fresh.sessions[sessionId] !== undefined;
  delete fresh.sessions[sessionId];
  ensureDir(belayDir());
  atomicWriteJSON(awaitPath(), fresh);
  return had;
}
