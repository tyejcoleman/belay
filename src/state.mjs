import { join } from 'node:path';
import { belayDir, ensureDir, atomicWriteJSON, readJSON } from './util.mjs';

// Belay's OWN state: ~/.belay/state.json — one tiny counter record per session.
//   { sessions: { <session_id>: { goalId, continuations, staleBlocked, updated_at } } }
// continuations = how many times the Stop hook has blocked (continued) this session on
// this goal; staleBlocked = whether the single "run goal_assess first" block was spent.
// Both reset when the session's focused goalId changes. Entries self-prune after 7 days.

const PRUNE_SEC = 7 * 86400;
const statePath = () => join(belayDir(), 'state.json');

export function readOwnState() {
  const s = readJSON(statePath());
  if (s && typeof s === 'object' && s.sessions && typeof s.sessions === 'object' && !Array.isArray(s.sessions)) return s;
  return { sessions: {} };
}

/** The (session, goal) entry — reset to zero counters when the goal changed. */
export function sessionEntry(state, sessionId, goalId) {
  const e = state.sessions[sessionId || 'unknown'];
  if (e && typeof e === 'object' && e.goalId === goalId) {
    return {
      goalId,
      continuations: typeof e.continuations === 'number' && Number.isFinite(e.continuations) && e.continuations >= 0 ? e.continuations : 0,
      staleBlocked: e.staleBlocked === true,
    };
  }
  return { goalId, continuations: 0, staleBlocked: false };
}

export function saveSessionEntry(state, sessionId, entry, nowSec = Date.now() / 1000) {
  // Per-entry read-modify-write over the FRESHEST copy (refute L1-1): the caller's
  // snapshot can be tens of ms old (hookStop holds it across readBudget + decideStop),
  // and writing that snapshot back wholesale reverted counter increments a CONCURRENT
  // stop hook had just persisted — eroding the ADR-6 bound one lost update at a time.
  // Re-reading at write time shrinks the race to the read→rename microseconds and merges
  // ONLY our entry — the same last-writer-wins-per-entry (never per-file) discipline
  // keyoku's store documents. Atomic rename still prevents torn files.
  const fresh = readOwnState();
  for (const k of Object.keys(fresh.sessions)) {
    const e = fresh.sessions[k];
    if (!e || typeof e !== 'object' || nowSec - (typeof e.updated_at === 'number' ? e.updated_at : 0) > PRUNE_SEC) delete fresh.sessions[k];
  }
  fresh.sessions[sessionId || 'unknown'] = { ...entry, updated_at: nowSec };
  ensureDir(belayDir());
  atomicWriteJSON(statePath(), fresh);
  state.sessions[sessionId || 'unknown'] = fresh.sessions[sessionId || 'unknown']; // keep the caller's snapshot coherent
}

/** Multi-entry updates with the same L1-1 discipline: read-fresh → mutate → write.
 *  `fn` mutates the fresh state in place and returns true when something changed. */
export function mutateOwnState(fn) {
  const fresh = readOwnState();
  if (fn(fresh) !== true) return false;
  ensureDir(belayDir());
  atomicWriteJSON(statePath(), fresh);
  return true;
}
