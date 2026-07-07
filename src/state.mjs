import { join } from 'node:path';
import { belayDir, ensureDir, atomicWriteJSON, readJSON } from './util.mjs';

// Belay's OWN state: ~/.belay/state.json — one tiny counter record per session.
//   { sessions:   { <session_id>: { goalId, continuations, staleBlocked, lastUnmetHash,
//                                   sameUnmetCount, updated_at } },
//     portfolios: { <session_id>: { <goalId>: { goalId, continuations, staleBlocked,
//                                   lastUnmetHash, sameUnmetCount, updated_at } } } }   ← B3/ADR-25
// continuations = how many times the Stop hook has blocked (continued) this session on
// this goal; staleBlocked = whether the single "run goal_assess first" block was spent;
// lastUnmetHash + sameUnmetCount = thrash detection (ADR-21) — how many consecutive blocks
// have carried the SAME unmet set (so the guidance can switch to "change strategy"). All
// reset when the session's focused goalId changes. Entries self-prune after 7 days.
//
// `sessions` is the flat SINGLE-goal slot (one goalId per session) and is left ENTIRELY
// untouched by the portfolio code, so a session steering one goal is byte-identical to
// pre-B3. `portfolios` is ADDITIVE and used ONLY when a session drives >=2 owned active
// goals (B3): it gives each (session, goal) its own DURABLE continuation counter — the
// backbone of the per-goal ADR-6 termination bound under rotation. The two maps never
// clobber each other: every write is a read-fresh-then-write of the WHOLE object (L1-1),
// and the two code paths are disjoint (a stop is EITHER single-flat OR portfolio, never both).

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
      lastUnmetHash: typeof e.lastUnmetHash === 'string' ? e.lastUnmetHash : null,
      sameUnmetCount: typeof e.sameUnmetCount === 'number' && Number.isFinite(e.sameUnmetCount) && e.sameUnmetCount >= 0 ? e.sameUnmetCount : 0,
    };
  }
  return { goalId, continuations: 0, staleBlocked: false, lastUnmetHash: null, sameUnmetCount: 0 };
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

// ── B3/ADR-25: per-(session, goal) portfolio counters ────────────────────────────────────
// A session driving MANY owned goals needs a durable continuation counter PER goal (the flat
// `sessions` slot holds only one goalId). These live in `portfolios[sessionId][goalId]` and
// carry the identical field-shape as a flat entry, so decideStop treats a portfolio entry and
// a flat entry interchangeably. Used only on the portfolio path; single-goal state is untouched.

/** The (session, goal) portfolio entry — same normalized shape sessionEntry returns.
 *  Absent → fresh zero-history entry (so a never-steered owned goal starts at a full budget). */
export function portfolioEntry(state, sessionId, goalId) {
  const e = state?.portfolios?.[sessionId || 'unknown']?.[goalId];
  if (e && typeof e === 'object') {
    return {
      goalId,
      continuations: typeof e.continuations === 'number' && Number.isFinite(e.continuations) && e.continuations >= 0 ? e.continuations : 0,
      staleBlocked: e.staleBlocked === true,
      lastUnmetHash: typeof e.lastUnmetHash === 'string' ? e.lastUnmetHash : null,
      sameUnmetCount: typeof e.sameUnmetCount === 'number' && Number.isFinite(e.sameUnmetCount) && e.sameUnmetCount >= 0 ? e.sameUnmetCount : 0,
    };
  }
  return { goalId, continuations: 0, staleBlocked: false, lastUnmetHash: null, sameUnmetCount: 0 };
}

/** belay's timestamp of the LAST time IT steered (persisted) this (session, goal) — the
 *  round-robin key (oldest first). 0 = never steered → picked first. */
export function portfolioSteeredAt(state, sessionId, goalId) {
  const t = state?.portfolios?.[sessionId || 'unknown']?.[goalId]?.updated_at;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

/** Read-modify-write ONE portfolio entry over the freshest copy (L1-1, exactly like
 *  saveSessionEntry): prune stale (session,goal) entries (7d) and empty session buckets,
 *  merge only our entry, atomic-rename. Leaves the flat `sessions` map untouched. */
export function savePortfolioEntry(state, sessionId, goalId, entry, nowSec = Date.now() / 1000) {
  const sid = sessionId || 'unknown';
  const fresh = readOwnState();
  if (!fresh.portfolios || typeof fresh.portfolios !== 'object' || Array.isArray(fresh.portfolios)) fresh.portfolios = {};
  for (const s of Object.keys(fresh.portfolios)) {
    const bucket = fresh.portfolios[s];
    if (!bucket || typeof bucket !== 'object') {
      delete fresh.portfolios[s];
      continue;
    }
    for (const g of Object.keys(bucket)) {
      const e = bucket[g];
      if (!e || typeof e !== 'object' || nowSec - (typeof e.updated_at === 'number' ? e.updated_at : 0) > PRUNE_SEC) delete bucket[g];
    }
    if (Object.keys(bucket).length === 0) delete fresh.portfolios[s];
  }
  if (!fresh.portfolios[sid] || typeof fresh.portfolios[sid] !== 'object') fresh.portfolios[sid] = {};
  fresh.portfolios[sid][goalId] = { ...entry, goalId, updated_at: nowSec };
  ensureDir(belayDir());
  atomicWriteJSON(statePath(), fresh);
  // keep the caller's snapshot coherent (mirrors saveSessionEntry)
  if (!state.portfolios || typeof state.portfolios !== 'object') state.portfolios = {};
  if (!state.portfolios[sid] || typeof state.portfolios[sid] !== 'object') state.portfolios[sid] = {};
  state.portfolios[sid][goalId] = fresh.portfolios[sid][goalId];
}

/** Counters for READ surfaces (status/briefing): the portfolio entry when one exists, else
 *  the flat entry — so a portfolio goal reports its real counters and a single-goal session
 *  is byte-identical (no portfolio entry → sessionEntry). */
export function resolveEntry(state, sessionId, goalId) {
  if (goalId != null && state?.portfolios?.[sessionId || 'unknown']?.[goalId]) return portfolioEntry(state, sessionId, goalId);
  return sessionEntry(state, sessionId, goalId);
}

/** Additive continuation total for a goal across BOTH the flat sessions map and every
 *  session's portfolio bucket (the `belay loop list` sum; ADR-25 keeps portfolio spends visible). */
export function sumContinuations(state, goalId) {
  let total = 0;
  for (const e of Object.values(state.sessions ?? {})) {
    if (e && typeof e === 'object' && e.goalId === goalId && typeof e.continuations === 'number' && Number.isFinite(e.continuations)) total += e.continuations;
  }
  for (const bucket of Object.values(state.portfolios ?? {})) {
    if (!bucket || typeof bucket !== 'object') continue;
    const e = bucket[goalId];
    if (e && typeof e === 'object' && typeof e.continuations === 'number' && Number.isFinite(e.continuations)) total += e.continuations;
  }
  return total;
}
