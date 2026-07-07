import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJSON, sanitizeText, sanitizeSlug, belayDir } from './util.mjs';

// Keyoku read contract (ADR-1: files, not processes — mapped 2026-07-01 against
// keyoku 2.12.x source; pinned >=2.7 <3, layout self-checked by `belay doctor`):
//   $KEYOKU_HOME || ~/.keyoku
//   paused                       marker file — present means belay no-ops entirely
//   focus.json                   {goalId, goalSlug?, cwd?, sessionId?, at} — GLOBAL singleton
//   goals.json                   array of goal rows (atomic whole-array writes)
//   observations/<goalId>.jsonl  append-only; tail line ≈ {unmet:[ids], summary, at}
// All keyoku writes are atomic tmp+rename or single-line appends → concurrent reads are
// safe; torn trailing JSONL lines are skipped. We NEVER run probes (arbitrary shell,
// 300s timeouts) and NEVER write focus.json/goals.json (whole-array clobber risk).
// Every field may be absent or malformed: anything unparseable → treat as no-goal → no-op.

export const keyokuHome = () => process.env.KEYOKU_HOME || join(homedir(), '.keyoku');

/**
 * Scope-match for a BLOCKING decision (ADR-5). Deliberately STRICTER than keyoku's own
 * autoRecordToFocusGoal attribution: a sessionId pin that does not match → not ours;
 * otherwise a cwd pin matches ONLY when the SESSION's cwd is inside the focus subtree
 * (a === b || a startsWith b + '/') — ONE-WAY, on purpose.
 *
 * Keyoku attributes bidirectionally (either dir), but attribution is advisory; belay
 * BLOCKS a stop, so it must be conservative. The dropped direction (focus.cwd inside the
 * SESSION cwd) is exactly the hole: a session running at an ANCESTOR of the goal's cwd
 * (an orchestrator at the repo root, or a shell at '/' or $HOME) would match every focus
 * and get its stop held for a goal it is not driving — until keyoku pins a sessionId.
 * The trailing-slash strip is guarded so an empty string (from cwd '/') cannot match
 * everything. An unscoped focus (no sessionId, no cwd) still matches all — that is a
 * genuinely global focus the user set. A cwd-scoped focus with no payload cwd → NOT
 * matched (we cannot prove scope, and a wrong match blocks a stranger's stop).
 */
export function scopeMatch(focus, sessionId, cwd) {
  if (typeof focus?.sessionId === 'string' && focus.sessionId) {
    if (focus.sessionId !== sessionId) return false;
  }
  if (typeof focus?.cwd === 'string' && focus.cwd) {
    if (typeof cwd !== 'string' || !cwd) return false;
    const a = cwd.replace(/\/+$/, '');
    const b = focus.cwd.replace(/\/+$/, '');
    if (!a || !b) return false; // '/' strips to '' — must never match everything
    return a === b || a.startsWith(b + '/');
  }
  return true;
}

/**
 * Latest usable observation: walk back from the tail, skip torn/unparseable lines,
 * prefer the most recent line that actually carries an `unmet` array (assessment/
 * convergence records); fall back to the last parseable line for freshness only.
 */
export function tailObservation(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let lastParseable = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // torn trailing line (append in flight) — keep walking back
    }
    if (!o || typeof o !== 'object') continue;
    if (Array.isArray(o.unmet)) return o;
    lastParseable ??= o;
  }
  return lastParseable;
}

/**
 * belay's OWN loops.json map, shape-guarded exactly like loops.mjs readLoops but read
 * DIRECTLY here (never importing loops.mjs — that module imports keyoku.mjs, so importing
 * it back would form a cycle). Never throws: absent/malformed → {} (every B3 branch then
 * degrades to the pre-B3 global-focus path). @returns {Record<string, object>} */
function readLoopsMap() {
  const s = readJSON(join(belayDir(), 'loops.json'));
  return s && typeof s === 'object' && s.loops && typeof s.loops === 'object' && !Array.isArray(s.loops) ? s.loops : {};
}

/**
 * B3 (ADR-25): the goalIds of the loops THIS session OWNS and can be held on — the armed,
 * non-paused, `session_id`-PINNED loops.json entries whose keyoku goal row is `active`.
 * Sorted by `armed_at` (asc) then goalId, so membership + ordering are deterministic and
 * stable. Returns [] when sessionId is falsy, goals are unreadable, or the session owns
 * none. This is the PER-SESSION focus derivation: a global focus.json flip by ANOTHER
 * session touches nothing here, so it can never evict this session's owned loops.
 *
 * ONLY entries carrying `session_id === sessionId` participate — a `scope:'global'` loop
 * (session_id null) is deliberately excluded, so it keeps flowing through the global
 * focus.json + scopeMatch path (its documented "hold every session under the cwd" semantics).
 * Existing loops.json fixtures written WITHOUT a session_id therefore never trip B3, keeping
 * the pre-B3 behavior byte-identical. Never throws.
 *
 * @param {string|undefined} sessionId  @param {any[]} goals  @param {Record<string,object>} [loopsMap]
 * @returns {string[]}
 */
export function sessionOwnedGoalIds(sessionId, goals, loopsMap = readLoopsMap()) {
  if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(goals) || !loopsMap || typeof loopsMap !== 'object') return [];
  const owned = [];
  for (const [goalId, e] of Object.entries(loopsMap)) {
    if (!e || typeof e !== 'object' || e.session_id !== sessionId || e.armed !== true || e.paused === true) continue;
    const g = goals.find((x) => x && typeof x === 'object' && x.id === goalId && typeof x.status === 'string');
    if (!g || g.status !== 'active') continue; // only an active goal can hold a stop — decideStop allows every other status
    owned.push({ goalId, armedAt: typeof e.armed_at === 'number' && Number.isFinite(e.armed_at) ? e.armed_at : 0 });
  }
  owned.sort((a, b) => a.armedAt - b.armedAt || (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0));
  return owned.map((o) => o.goalId);
}

/**
 * One snapshot per hook invocation (3-4 file reads, ~10ms):
 * {home, present, paused, focus, matched, goal, obs}. Any missing/malformed layer stops
 * the descent and leaves the deeper fields null — callers treat that as "no goal".
 *
 * B3/ADR-25 — PER-SESSION focus resolution: the goal a stop should steer is derived from
 * belay's OWN loops.json (the goal THIS session owns), NOT from keyoku's GLOBAL focus.json
 * singleton. When this session owns >=1 active pinned loop, we steer it regardless of what
 * focus.json currently holds — so a focus flip by a concurrent session can never evict us.
 * When the session owns NONE, we fall back to focus.json + scopeMatch, BYTE-IDENTICAL to
 * pre-B3 (this is the single reader; the Stop hook drives a whole owned SET via
 * decidePortfolio — here we resolve the most-recently-armed owned goal for the gate/status/
 * briefing surfaces, which only need one representative).
 */
export function readKeyoku({ sessionId, cwd } = {}) {
  const home = keyokuHome();
  const out = { home, present: false, paused: false, focus: null, matched: false, goal: null, obs: null };
  if (!existsSync(home)) return out;
  out.present = true;
  if (existsSync(join(home, 'paused'))) {
    out.paused = true;
    return out;
  }
  const goals = readJSON(join(home, 'goals.json'));
  const raw = readJSON(join(home, 'focus.json'));
  const globalFocus = raw && typeof raw === 'object' && typeof raw.goalId === 'string' && raw.goalId ? raw : null;

  // B3: prefer this session's OWN loop over the global singleton (no cross-session eviction).
  const owned = Array.isArray(goals) ? sessionOwnedGoalIds(sessionId, goals) : [];
  let effFocus;
  if (owned.length) {
    const goalId = owned[owned.length - 1]; // most-recently-armed (owned is armed_at-asc)
    // keep the real focus object when the singleton already agrees (byte-identical slug/scope
    // for the single-session single-goal case); otherwise synthesize a session-pinned focus.
    effFocus = globalFocus && globalFocus.goalId === goalId ? globalFocus : { goalId, goalSlug: undefined, sessionId };
    out.focus = effFocus;
    out.matched = true; // our own owned loop is definitionally in scope for us
  } else {
    if (!globalFocus) return out; // pre-B3: invalid/absent focus → no-focus
    effFocus = globalFocus;
    out.focus = effFocus;
    out.matched = scopeMatch(globalFocus, sessionId, cwd);
    if (!out.matched) return out;
  }
  if (!Array.isArray(goals)) return out; // corrupted / future-SQLite layout → no-goal (doctor flags it)
  const goal = goals.find((g) => g && typeof g === 'object' && g.id === effFocus.goalId);
  if (!goal || typeof goal.status !== 'string') return out;
  out.goal = goal;
  out.obs = tailObservation(join(home, 'observations', `${effFocus.goalId}.jsonl`));
  return out;
}

export const goalSlug = (goal, focus) => {
  for (const v of [goal?.slug, focus?.goalSlug, goal?.id]) if (typeof v === 'string' && v) return v;
  return 'unknown';
};

/**
 * Join unmet criterion IDs ("c1") to their descriptions from goal.criteria.
 * Returns null when the observation carries no unmet array at all (unknown state),
 * [] when it affirmatively says nothing is unmet.
 *
 * ids AND descriptions are sibling-goal-controlled data that lands in a model-visible
 * block reason, so both are sanitized here (ADR-7): ids to a tame charset, descriptions
 * to single-line control-char-free text capped at 120 chars.
 */
// The join was `ids.map(id => criteria.find(...))` — O(unmet × criteria). A pathological or
// hostile goal with tens of thousands of criteria AND unmet ids made this run for seconds
// (measured 21s at 100k×100k), and since it runs in decideStop it could blow the Stop hook's
// 10s timeout → the hook is KILLED → the stop fails OPEN, releasing a hold it should keep
// (refute F2). Fixed two ways: index criteria by id once (O(1) lookup), and CAP the number of
// unmet ids materialized (the joined reason is byte-capped downstream anyway, and belay_status
// count-caps too, so nothing truthful is lost — a pathological set is truncated, not trusted).
const UNMET_DETAIL_CAP = 500;
export function unmetDetail(goal, obs) {
  if (!obs || !Array.isArray(obs.unmet)) return null;
  const criteria = Array.isArray(goal?.criteria) ? goal.criteria : [];
  const byId = new Map();
  for (const c of criteria) {
    if (c && typeof c === 'object' && typeof c.id === 'string' && !byId.has(c.id)) byId.set(c.id, c);
  }
  const out = [];
  let seen = 0;
  for (const id of obs.unmet) {
    if (typeof id !== 'string' || !id) continue;
    if (seen++ >= UNMET_DETAIL_CAP) {
      out.push(`…(${obs.unmet.length - UNMET_DETAIL_CAP}+ more unmet criteria truncated)`);
      break;
    }
    const sid = sanitizeSlug(id, 40);
    const c = byId.get(id);
    out.push(c && typeof c.description === 'string' && c.description ? `${sid}: ${sanitizeText(c.description, 120)}` : sid);
  }
  return out;
}
