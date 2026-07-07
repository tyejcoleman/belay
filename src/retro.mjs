import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { belayDir, ensureDir, readJSON, readConfig, sanitizeText, sanitizeSlug } from './util.mjs';
import { keyokuHome, goalSlug } from './keyoku.mjs';
import { readOwnState } from './state.mjs';

// Learning flywheel (ADR-21 follow-through): belay sits on telemetry no other tool has — which
// loops thrashed, which converged in two continuations, which stalled out. That signal used to
// evaporate at disarm. A retro captures it to ~/.belay/retros.jsonl on every stand-down (a pure
// local write, no spawn), and `belay loop retro <goal>` can additionally FILE it into keyoku's
// own knowledge store (via keyoku's registered process, ADR-10) so it grounds future goal_assess
// guidance. keyoku stays the single brain; belay only contributes an observation it alone holds.

const RETRO_CAP_BYTES = 256 * 1024;
const retrosPath = () => join(belayDir(), 'retros.jsonl');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Compose a retro for one goal from goals.json + belay's own state.json + the decisions
 *  journal — a pure read, never a spawn. Returns the retro object (or null if the goal is
 *  unknown to both keyoku and belay). */
export function buildRetro(goalId, { nowIso } = {}) {
  if (typeof goalId !== 'string' || !goalId) return null;
  const { cfg } = readConfig();
  const goals = readJSON(join(keyokuHome(), 'goals.json'));
  const row = Array.isArray(goals) ? goals.find((g) => g && typeof g === 'object' && g.id === goalId) : null;

  // belay-side counters across every session that drove this goal
  const own = readOwnState();
  let continuations = 0;
  let maxSameUnmet = 0;
  let staleBlocked = false;
  const tally = (e) => {
    if (!e || typeof e !== 'object' || e.goalId !== goalId) return;
    if (num(e.continuations) != null) continuations += e.continuations;
    if (num(e.sameUnmetCount) != null) maxSameUnmet = Math.max(maxSameUnmet, e.sameUnmetCount);
    if (e.staleBlocked === true) staleBlocked = true;
  };
  for (const e of Object.values(own.sessions)) tally(e);
  // B3/ADR-25: also fold in every session's PORTFOLIO copy of this goal (portfolio entries
  // store goalId, so the goalId guard in tally() scopes them correctly).
  for (const bucket of Object.values(own.portfolios ?? {})) {
    if (bucket && typeof bucket === 'object') for (const e of Object.values(bucket)) tally(e);
  }

  // decision-journal tally for this goal (best-effort; the journal is observability-only)
  const byKind = {};
  try {
    const lines = readFileSync(join(belayDir(), 'decisions.jsonl'), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d && d.goal === goalId && typeof d.kind === 'string') byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    }
  } catch {
    // no journal — leave byKind empty
  }

  const status = row && typeof row.status === 'string' ? row.status : 'unknown';
  return {
    at: typeof nowIso === 'string' ? nowIso : new Date().toISOString(),
    goalId,
    slug: sanitizeSlug(row ? goalSlug(row, null) : goalId),
    outcome: status,
    converged: status === 'converged',
    iterations: row ? num(row.usedIterations) : null,
    maxIterations: row ? num(row.maxIterations) : null,
    continuations,
    maxSameUnmet,
    thrashed: maxSameUnmet >= cfg.thrash_threshold,
    stalled: maxSameUnmet >= cfg.thrash_release,
    staleBlocked,
    decisions: byKind,
  };
}

/** Append a retro to ~/.belay/retros.jsonl (self-capping, 0600). Never throws (best-effort). */
export function writeRetro(retro) {
  try {
    ensureDir(belayDir());
    const path = retrosPath();
    try {
      if (statSync(path).size > RETRO_CAP_BYTES) {
        const lines = readFileSync(path, 'utf8').split('\n');
        writeFileSync(path, lines.slice(Math.floor(lines.length / 2)).join('\n'), { mode: 0o600 });
      }
    } catch {
      // no file yet
    }
    appendFileSync(path, JSON.stringify(retro) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Recent retros, newest last (absent/torn → []). */
export function readRetros(limit = 50) {
  let text;
  try {
    text = readFileSync(retrosPath(), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') out.push(o);
    } catch {
      /* torn line */
    }
  }
  return out.slice(-limit);
}

/** A one-line human/keyoku-facing summary of a retro. */
export function retroFact(r) {
  const bits = [
    `belay loop '${sanitizeSlug(r.slug, 48)}' ended ${sanitizeSlug(String(r.outcome), 24)}`,
    `${r.continuations} continuation(s)`,
    r.iterations != null ? `${r.iterations} keyoku iteration(s)` : null,
    r.thrashed ? `THRASHED (same unmet set ${r.maxSameUnmet}x)` : null,
    r.stalled ? 'STALLED to an early release' : null,
    r.staleBlocked ? 'hit the stale-assess block' : null,
  ].filter(Boolean);
  return sanitizeText(bits.join('; '), 2000);
}

/**
 * Record a retro for a goal: always write it locally; when `push` is set, ALSO file it into
 * keyoku's knowledge store via keyoku's own registered process (ADR-10). Best-effort on the
 * keyoku side — a missing/failing knowledge_submit degrades to "local only", never a throw.
 * @param {string} ref goal id or slug
 * @param {{ push?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, retro: object|null, pushed: boolean, push_error?: string }>}
 */
export async function recordRetro(ref, { push = false } = {}) {
  const goals = readJSON(join(keyokuHome(), 'goals.json'));
  const row = Array.isArray(goals) ? goals.find((g) => g && typeof g === 'object' && (g.id === ref || g.slug === ref)) : null;
  const goalId = row ? row.id : ref;
  const retro = buildRetro(goalId);
  if (!retro) return { ok: false, retro: null, pushed: false };
  const wrote = writeRetro(retro);
  let pushed = false;
  let push_error;
  if (push) {
    try {
      const { keyokuSession } = await import('./keyoku-client.mjs');
      const session = await keyokuSession();
      try {
        const out = await session.call('knowledge_submit', { subject: `domain:belay-loop:${retro.slug}`, kind: 'note', fact: retroFact(retro), source: 'agent-research' });
        pushed = !out?.error;
        if (out?.error) push_error = sanitizeText(String(out.error), 200);
      } finally {
        await session.close();
      }
    } catch (e) {
      push_error = sanitizeText(e?.message ?? String(e), 200);
    }
  }
  return { ok: wrote, retro, pushed, ...(push_error ? { push_error } : {}) };
}
