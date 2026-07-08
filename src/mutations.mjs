import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJSON, atomicWriteJSON, ensureDir, belayDir, sanitizeSlug } from './util.mjs';
import { keyokuHome, goalSlug } from './keyoku.mjs';
import { readLoops } from './loops.mjs';

// Goal-mutation tracking (docs/DECISIONS.md ADR-32): "ALWAYS CHECK FOR MUTATIONS" — belay
// persists a small snapshot of THIS session's OWNED keyoku goal states (id, slug, status,
// convergedAt, a cheap criteria fingerprint) and, on every subsequent read, diffs the LIVE
// state against that snapshot: newly-converged, newly-abandoned, status flips, criteria
// added/removed, new/removed owned goals. Read-only on keyoku (~/.keyoku is never written);
// the ONLY write is belay's own snapshot file, `~/.belay/goal-snap-<session>.json`. This is
// DETECTION/REPORTING ONLY — it never feeds a gate/stop decision (mirrors the ADR-16
// "no-path rule": no code path leads from this module to a block/allow/ask/deny verdict) and
// never loosens the PreToolUse arrest on goal-abandon/pause (ADR-19's `loop control` class is
// untouched by this file). Never-crash (ADR-4): every read/write here is guarded; a missing
// keyoku home, an absent/corrupt snapshot, or an unreadable loops.json/goals.json degrades to
// an EMPTY diff, never a throw.

/** "Owned" here mirrors belay's loops.json session pin (B3/ADR-25's ownership KEY) but does
 *  NOT filter to armed/non-paused/active like `sessionOwnedGoalIds` — mutation tracking wants
 *  to see the goal's status FLIP (e.g. active → converged/abandoned), so it must not exclude
 *  the very transitions it exists to report. */
const snapPath = (sessionId) => join(belayDir(), `goal-snap-${sanitizeSlug(sessionId, 80)}.json`);

/** Cheap, order-independent fingerprint of a goal's criteria set: {count, hash}. `hash` is a
 *  16-hex-char sha256 over the sorted `id:description` pairs — enough to detect an add/
 *  remove/edit without carrying the full criteria payload into the snapshot file. Never
 *  throws; a non-array `criteria` degrades to {count:0, hash:null}. */
export function criteriaFingerprint(criteria) {
  if (!Array.isArray(criteria)) return { count: 0, hash: null };
  const items = criteria
    .filter((c) => c && typeof c === 'object')
    .map((c) => `${typeof c.id === 'string' ? c.id : ''}:${typeof c.description === 'string' ? c.description : ''}`)
    .sort();
  const hash = createHash('sha256').update(items.join('\n')).digest('hex').slice(0, 16);
  return { count: items.length, hash };
}

/** THIS session's owned goal rows, keyed by goalId, in the exact shape persisted to/compared
 *  against the snapshot. Owned = a loops.json entry whose `session_id` matches (armed/paused/
 *  goal-status agnostic — see the note above). A goal row missing from goals.json (deleted
 *  from keyoku while still "owned" per belay's own file) is represented with status:'missing'
 *  rather than dropped, so a later re-appearance or permanent loss is still diffable. Never
 *  throws — any failure degrades to {}. */
export function currentOwnedGoals(sessionId, loopsMap, goalRows) {
  const out = {};
  if (typeof sessionId !== 'string' || !sessionId || !loopsMap || typeof loopsMap !== 'object') return out;
  const rows = Array.isArray(goalRows) ? goalRows : [];
  for (const [goalId, e] of Object.entries(loopsMap)) {
    if (!e || typeof e !== 'object' || e.session_id !== sessionId) continue;
    const g = rows.find((x) => x && typeof x === 'object' && x.id === goalId);
    out[goalId] = {
      slug: sanitizeSlug(g ? goalSlug(g, {}) : goalId, 64),
      status: g && typeof g.status === 'string' ? g.status : 'missing',
      convergedAt: g && typeof g.convergedAt === 'string' ? g.convergedAt : null,
      criteria: criteriaFingerprint(g?.criteria),
    };
  }
  return out;
}

/**
 * Pure diff between a PRIOR snapshot's goal map and the CURRENT owned-goal map (both the
 * `{goalId: {slug,status,convergedAt,criteria}}` shape `currentOwnedGoals` builds). Never
 * throws — malformed inputs are treated as empty maps.
 * @returns {{ newlyConverged, newlyAbandoned, statusFlips, criteriaChanges, newOwnedGoals, removedOwnedGoals }}
 */
export function diffGoalSnapshots(prevGoals, currGoals) {
  const prev = prevGoals && typeof prevGoals === 'object' ? prevGoals : {};
  const curr = currGoals && typeof currGoals === 'object' ? currGoals : {};
  const newlyConverged = [];
  const newlyAbandoned = [];
  const statusFlips = [];
  const criteriaChanges = [];
  const newOwnedGoals = [];
  const removedOwnedGoals = [];

  for (const [goalId, c] of Object.entries(curr)) {
    if (!c || typeof c !== 'object') continue;
    const p = prev[goalId];
    if (!p || typeof p !== 'object') {
      newOwnedGoals.push({ goalId, slug: c.slug, status: c.status });
      continue;
    }
    if (p.status !== c.status) {
      statusFlips.push({ goalId, slug: c.slug, from: p.status, to: c.status });
      if (c.status === 'converged') newlyConverged.push({ goalId, slug: c.slug });
      if (c.status === 'abandoned') newlyAbandoned.push({ goalId, slug: c.slug });
    }
    const pf = p.criteria && typeof p.criteria === 'object' ? p.criteria : { count: 0, hash: null };
    const cf = c.criteria && typeof c.criteria === 'object' ? c.criteria : { count: 0, hash: null };
    if (pf.hash !== cf.hash || pf.count !== cf.count) {
      criteriaChanges.push({ goalId, slug: c.slug, from: pf, to: cf, delta: (cf.count ?? 0) - (pf.count ?? 0) });
    }
  }
  for (const [goalId, p] of Object.entries(prev)) {
    if (!p || typeof p !== 'object') continue;
    if (!curr[goalId]) removedOwnedGoals.push({ goalId, slug: p.slug, lastStatus: p.status });
  }
  return { newlyConverged, newlyAbandoned, statusFlips, criteriaChanges, newOwnedGoals, removedOwnedGoals };
}

const EMPTY_DIFF = { newlyConverged: [], newlyAbandoned: [], statusFlips: [], criteriaChanges: [], newOwnedGoals: [], removedOwnedGoals: [] };

/** Sum of every "something changed" bucket EXCLUDING the newlyConverged/newlyAbandoned
 *  convenience subsets (those are already counted inside `statusFlips`) — the single number
 *  belay status's one-line summary and `belay mutations`' text form both use. Never throws:
 *  a malformed diff degrades every bucket length to 0. */
export function mutationCount(diff) {
  const len = (a) => (Array.isArray(a) ? a.length : 0);
  if (!diff || typeof diff !== 'object') return 0;
  return len(diff.statusFlips) + len(diff.criteriaChanges) + len(diff.newOwnedGoals) + len(diff.removedOwnedGoals);
}

/**
 * `belay mutations` core: read THIS session's live owned-goal state, diff it against the
 * last-persisted snapshot, persist a FRESH snapshot for the next check (best-effort — a
 * write failure never blocks reporting), and return the diff. Read-only on keyoku
 * (~/.keyoku); the only write is belay's own snapshot file. Never throws: no sessionId, no
 * keyoku home, or any read/parse failure degrades to an EMPTY diff with `hasPrior:false`,
 * exit-0-safe for the CLI caller.
 * @param {string|null|undefined} sessionId
 * @returns {{ sessionId: string|null, at: number, hasPrior: boolean } & typeof EMPTY_DIFF}
 */
export function computeMutations(sessionId) {
  const at = Math.round(Date.now() / 1000);
  const empty = { sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null, at, hasPrior: false, ...EMPTY_DIFF };
  try {
    if (typeof sessionId !== 'string' || !sessionId) return empty;
    const home = keyokuHome();
    if (!existsSync(home)) return empty;
    const goalRows = readJSON(join(home, 'goals.json'));
    const loopsMap = readLoops().loops; // degrades to {} on any error (ADR-4)
    const currGoals = currentOwnedGoals(sessionId, loopsMap, goalRows);

    const snap = readJSON(snapPath(sessionId));
    const hasPrior = !!(snap && typeof snap === 'object' && snap.goals && typeof snap.goals === 'object');
    // No prior snapshot at all → this check ESTABLISHES the baseline, it does not report
    // every currently-owned goal as "new" (that would be noise, not a mutation — there is
    // nothing to have mutated FROM yet). Diffing only ever runs against a REAL prior snapshot.
    const diff = hasPrior ? diffGoalSnapshots(snap.goals, currGoals) : { ...EMPTY_DIFF };

    try {
      ensureDir(belayDir());
      atomicWriteJSON(snapPath(sessionId), { session_id: sessionId, at, goals: currGoals });
    } catch {
      /* snapshot persistence is best-effort — a write failure never blocks the read */
    }
    return { sessionId, at, hasPrior, ...diff };
  } catch {
    return empty;
  }
}

/** Human-readable render of a `computeMutations()` result. Pure, no I/O. */
export function renderMutations(m) {
  const lines = [`belay mutations (session ${m?.sessionId ?? '(none)'})`];
  if (!m?.sessionId) {
    lines.push('  no session id — pass --session-id <id> or set $CLAUDE_CODE_SESSION_ID (nothing to report)');
    return lines.join('\n');
  }
  if (!m.hasPrior) {
    lines.push('  no prior snapshot for this session — baseline captured now; nothing to diff yet (the next check will show changes)');
  }
  const section = (label, rows, fmt) => {
    if (!Array.isArray(rows) || !rows.length) return;
    lines.push(`  ${label} (${rows.length}):`);
    for (const r of rows) lines.push(`    - ${fmt(r)}`);
  };
  section('newly converged', m.newlyConverged, (r) => `${r.slug} (${r.goalId})`);
  section('newly abandoned', m.newlyAbandoned, (r) => `${r.slug} (${r.goalId})`);
  section('status flips', m.statusFlips, (r) => `${r.slug}: ${r.from} → ${r.to}`);
  section('criteria changed', m.criteriaChanges, (r) => `${r.slug}: ${r.from?.count ?? 0} → ${r.to?.count ?? 0} criteria (${r.delta > 0 ? '+' : ''}${r.delta})`);
  section('new owned goals', m.newOwnedGoals, (r) => `${r.slug} (${r.status})`);
  section('removed owned goals', m.removedOwnedGoals, (r) => `${r.slug} (last status: ${r.lastStatus})`);
  if (m.hasPrior && mutationCount(m) === 0) lines.push('  no changes since last check');
  return lines.join('\n');
}

/** `belay mutations` CLI entry point. `--session-id <id>` else `$CLAUDE_CODE_SESSION_ID`;
 *  neither present → an empty, session-less report (never crashes, exit 0 via the bin's
 *  normal fallthrough — this function never throws). `--json` prints the raw diff object. */
export function mutationsCommand(f = {}) {
  const sessionId = typeof f.session_id === 'string' && f.session_id ? f.session_id : typeof process.env.CLAUDE_CODE_SESSION_ID === 'string' && process.env.CLAUDE_CODE_SESSION_ID ? process.env.CLAUDE_CODE_SESSION_ID : null;
  const m = computeMutations(sessionId);
  if (f.json === true) console.log(JSON.stringify(m, null, 2));
  else console.log(renderMutations(m));
}
