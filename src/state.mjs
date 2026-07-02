import { join } from 'node:path';
import { conductorDir, ensureDir, atomicWriteJSON, readJSON } from './util.mjs';

// Conductor's OWN state: ~/.conductor/state.json — one tiny counter record per session.
//   { sessions: { <session_id>: { goalId, continuations, staleBlocked, updated_at } } }
// continuations = how many times the Stop hook has blocked (continued) this session on
// this goal; staleBlocked = whether the single "run goal_assess first" block was spent.
// Both reset when the session's focused goalId changes. Entries self-prune after 7 days.

const PRUNE_SEC = 7 * 86400;
const statePath = () => join(conductorDir(), 'state.json');

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
  for (const k of Object.keys(state.sessions)) {
    const e = state.sessions[k];
    if (!e || typeof e !== 'object' || nowSec - (typeof e.updated_at === 'number' ? e.updated_at : 0) > PRUNE_SEC) delete state.sessions[k];
  }
  state.sessions[sessionId || 'unknown'] = { ...entry, updated_at: nowSec };
  ensureDir(conductorDir());
  atomicWriteJSON(statePath(), state);
}
