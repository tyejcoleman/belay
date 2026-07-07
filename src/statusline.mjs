import { join } from 'node:path';
import { readJSON, sanitizeSlug } from './util.mjs';
import { readLoops } from './loops.mjs';
import { keyokuHome, goalSlug, tailObservation } from './keyoku.mjs';

// `belay statusline` (docs/DECISIONS.md ADR-30): a PERSISTENT, compact indicator that THIS
// Claude Code session is in "loop mode" — read-only, no network, no spawn, hook-latency-safe
// (a handful of file reads, same budget as the Stop hook), and NEVER crashes: a statusline
// command runs on every UI refresh, so any failure anywhere degrades to '' (ADR-4 discipline,
// same choke-point posture as bin/belay.mjs's `hook` dispatch). It reuses the exact B3
// ownership predicate (session_id-pinned, armed, active goal row — src/stop.mjs
// `ownedActiveUnits` / src/keyoku.mjs `sessionOwnedGoalIds`) but does NOT exclude paused
// entries, since the statusline wants to render them distinctly (⏸) rather than hide them.

const STATUSLINE_SLUG_CAP = 24; // short — statuslines are cramped; sanitizeSlug's own default (64) is for model-visible reasons

/**
 * Read the JSON payload Claude Code pipes to a statusline command's stdin
 * ({session_id, cwd, model, ...} — same shape as a hook payload). Never throws:
 * empty/malformed/absent stdin → null (the caller then falls back to the env var).
 */
async function readStdinJSON() {
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    return null;
  }
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/** Resolve THIS session's id: the stdin payload's `session_id` wins; else
 *  `$CLAUDE_CODE_SESSION_ID` (both official Claude Code statusline surfaces per the task —
 *  the JSON blob and the env var). null when neither is present/usable. */
export function resolveSessionId(payload) {
  if (payload && typeof payload.session_id === 'string' && payload.session_id) return payload.session_id;
  if (typeof process.env.CLAUDE_CODE_SESSION_ID === 'string' && process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  return null;
}

/**
 * THIS session's armed loops.json entries whose keyoku goal row is `active` — both
 * non-paused AND paused (the B3 ownership predicate from `sessionOwnedGoalIds`/
 * `ownedActiveUnits`, minus the `paused !== true` filter those apply, since the statusline
 * renders a paused loop distinctly rather than treating it as unowned). Read-only
 * (loops.json is passed in; one goals.json read; one observation-tail read per non-paused
 * unit, mirroring `ownedActiveUnits`'s per-unit obs read). Never throws — any failure yields
 * []. @returns {Array<{goalId, slug, paused, armedAt, criteriaTotal, unmetCount}>}
 */
export function ownedLoopsForStatusline(sessionId, loopsMap) {
  if (typeof sessionId !== 'string' || !sessionId || !loopsMap || typeof loopsMap !== 'object') return [];
  try {
    const goals = readJSON(join(keyokuHome(), 'goals.json'));
    if (!Array.isArray(goals)) return [];
    const out = [];
    for (const [goalId, e] of Object.entries(loopsMap)) {
      if (!e || typeof e !== 'object' || e.session_id !== sessionId || e.armed !== true) continue;
      const g = goals.find((x) => x && typeof x === 'object' && x.id === goalId && typeof x.status === 'string');
      if (!g || g.status !== 'active') continue;
      const paused = e.paused === true;
      // Cheap only: the already-written observation tail (no probe run — ADR-1/ADR-4).
      const obsRec = paused ? null : tailObservation(join(keyokuHome(), 'observations', `${goalId}.jsonl`));
      out.push({
        goalId,
        slug: sanitizeSlug(goalSlug(g, {}), STATUSLINE_SLUG_CAP),
        paused,
        armedAt: typeof e.armed_at === 'number' && Number.isFinite(e.armed_at) ? e.armed_at : 0,
        criteriaTotal: Array.isArray(g.criteria) ? g.criteria.length : null,
        unmetCount: obsRec && Array.isArray(obsRec.unmet) ? obsRec.unmet.length : null,
      });
    }
    out.sort((a, b) => a.armedAt - b.armedAt || (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0));
    return out;
  } catch {
    return [];
  }
}

/** ` <met>/<total>` suffix from the loop's latest observation, when cheaply known — else ''
 *  (never invents a figure, ADR-4). */
function metSuffix(u) {
  if (u.criteriaTotal == null || u.unmetCount == null) return '';
  const met = Math.max(0, u.criteriaTotal - u.unmetCount);
  return ` ${met}/${u.criteriaTotal}`;
}

/**
 * Pure render: the already-resolved unit list → the one-line indicator (independently
 * testable, no I/O). '' when the session owns no armed active loop (paused or not) — the
 * statusline then shows nothing extra. A distinctive glyph makes loop-mode unmistakable:
 * ⟳ for at-least-one ACTIVE (non-paused) owned loop, ⏸ when every owned loop is paused.
 * Single loop names its slug (+ `<met>/<total>` when cheaply known); N>1 collapses to a
 * compact `×N` count — statuslines are cramped, and this stays O(1) width regardless of
 * portfolio size. A mix of active + paused loops leads with the ⟳ active summary and
 * appends a short paused count so neither is silently hidden.
 */
export function renderStatusline(units) {
  const active = units.filter((u) => !u.paused);
  const paused = units.filter((u) => u.paused);
  if (active.length === 0 && paused.length === 0) return '';
  let out;
  if (active.length === 1) out = `⟳ loop ${active[0].slug}${metSuffix(active[0])}`;
  else if (active.length > 1) out = `⟳ loop ×${active.length}`;
  else if (paused.length === 1) out = `⏸ loop ${paused[0].slug}`;
  else out = `⏸ loop ×${paused.length}`;
  if (active.length > 0 && paused.length > 0) out += ` (+${paused.length}⏸)`;
  return out;
}

/**
 * `belay statusline` — the statusLine-command entry point. Resolves this session's id from
 * stdin JSON (else $CLAUDE_CODE_SESSION_ID), gathers its owned armed loops, and returns the
 * rendered indicator. NEVER throws: every failure (malformed stdin, unreadable/corrupted
 * state, a keyoku layout change) degrades to '' — a statusline command must never crash the
 * UI (ADR-4, same discipline as every belay hook). Read-only, no network, no spawn.
 * @returns {Promise<string>}
 */
export async function statusline() {
  try {
    const payload = await readStdinJSON();
    const sessionId = resolveSessionId(payload);
    if (!sessionId) return '';
    const loopsMap = readLoops().loops;
    const units = ownedLoopsForStatusline(sessionId, loopsMap);
    return renderStatusline(units);
  } catch {
    return '';
  }
}
