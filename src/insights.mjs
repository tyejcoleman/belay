import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { belayDir, readJSON } from './util.mjs';
import { pendingSummary } from './pending.mjs';
import { readRetros } from './retro.mjs';
import { readLoops } from './loops.mjs';

// `belay insights` — turn belay's OWN production journal into a read on how it is actually
// behaving: is it staying a no-op for normal work, how often the fall-arrest fires and on what,
// which loops thrash, what is queued for review. Pure reads over ~/.belay; no spawn, no network.
//
// Decision kinds bucketed by what they MEAN (stop.mjs/gate.mjs emit these):
//   idle     — belay was not engaged at all (correct 94%-of-the-time no-op)
//   released — engaged but allowed the stop (converged / exhausted / paused / descent)
//   held     — the Stop hook BLOCKED (the rope did its job)
//   gated    — the PreToolUse fall-arrest ASK/DENY'd an irreversible action

const IDLE = new Set(['keyoku-absent', 'no-focus', 'scope-mismatch', 'goal-missing', 'paused']);
const HELD = new Set(['block', 'block-thrash', 'block-stalled', 'stale-block', 'unmet-unknown']);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Read the append-only decisions journal defensively (torn lines skipped). */
function readDecisions() {
  let text;
  try {
    text = readFileSync(join(belayDir(), 'decisions.jsonl'), 'utf8');
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
      /* torn */
    }
  }
  return out;
}

const bucket = (kind, action) => {
  if (action === 'ask' || action === 'deny') return 'gated';
  if (HELD.has(kind)) return 'held';
  if (IDLE.has(kind)) return 'idle';
  return 'released';
};

/**
 * Compose the production insight object from belay's own state files.
 * @param {{ nowSec?: number }} [opts]
 */
export function buildInsights({ nowSec = Date.now() / 1000 } = {}) {
  const decisions = readDecisions();
  const byAction = {};
  const byKind = {};
  const buckets = { idle: 0, released: 0, held: 0, gated: 0 };
  const gatedByClass = {};
  const sessions = new Set();
  const goals = new Set();
  let firstAt = null;
  let lastAtSec = null;
  for (const d of decisions) {
    const action = typeof d.action === 'string' ? d.action : 'unknown';
    const kind = typeof d.kind === 'string' ? d.kind : 'unknown';
    byAction[action] = (byAction[action] ?? 0) + 1;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    buckets[bucket(kind, action)]++;
    if (action === 'ask' || action === 'deny') gatedByClass[kind] = (gatedByClass[kind] ?? 0) + 1;
    if (d.session_id) sessions.add(d.session_id);
    if (d.goal) goals.add(d.goal);
    if (typeof d.at === 'string') {
      firstAt ??= d.at;
      const s = Date.parse(d.at);
      if (Number.isFinite(s)) lastAtSec = Math.max(lastAtSec ?? 0, s / 1000);
    }
  }

  const retros = readRetros(500);
  const rOutcomes = {};
  let thrashed = 0;
  let contSum = 0;
  let contN = 0;
  for (const r of retros) {
    rOutcomes[r.outcome ?? 'unknown'] = (rOutcomes[r.outcome ?? 'unknown'] ?? 0) + 1;
    if (r.thrashed) thrashed++;
    if (num(r.continuations) != null) {
      contSum += r.continuations;
      contN++;
    }
  }

  const loops = Object.values(readLoops().loops).filter((e) => e && typeof e === 'object');
  const props = readJSON(join(belayDir(), 'proposals.json'));
  const openProps = props && Array.isArray(props.proposals) ? props.proposals.filter((p) => p && p.status === 'open').length : 0;

  const total = decisions.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return {
    decisions: {
      total,
      distinct_sessions: sessions.size,
      distinct_goals: goals.size,
      first_at: firstAt,
      last_age_min: lastAtSec == null ? null : Math.max(0, Math.round((nowSec - lastAtSec) / 60)),
      by_action: byAction,
      by_kind: byKind,
    },
    behavior: {
      idle: buckets.idle,
      released: buckets.released,
      held: buckets.held,
      gated: buckets.gated,
      no_op_pct: pct(buckets.idle), // high = correctly not policing normal work
      engaged_pct: pct(buckets.held + buckets.gated + buckets.released),
    },
    fall_arrest: { total_acts: buckets.gated, by_class: gatedByClass },
    pending: pendingSummary(),
    retros: { count: retros.length, outcomes: rOutcomes, thrashed, avg_continuations: contN ? Math.round((contSum / contN) * 10) / 10 : null },
    loops: { armed: loops.filter((e) => e.armed === true && e.paused !== true).length, paused: loops.filter((e) => e.paused === true).length },
    proposals_open: openProps,
  };
}

const bar = (n, total, w = 24) => {
  const filled = total ? Math.round((n / total) * w) : 0;
  return '█'.repeat(filled) + '·'.repeat(w - filled);
};

/** Human-readable render of buildInsights() for the CLI. */
export function renderInsights(ins) {
  const L = [];
  const d = ins.decisions;
  L.push('belay insights — how the harness is actually behaving in production\n');
  if (d.total === 0) {
    L.push('  no decisions journaled yet — belay has not been exercised on this machine.');
    return L.join('\n');
  }
  L.push(`  ${d.total} decisions · ${d.distinct_sessions} sessions · ${d.distinct_goals} goals · since ${d.first_at?.slice(0, 10) ?? '?'}`);
  L.push(`  hook liveness: last decision ${d.last_age_min == null ? '?' : `${d.last_age_min}m ago`} (hooks are firing = enforcement is wired into the live harness)\n`);

  const b = ins.behavior;
  L.push('  what belay did:');
  L.push(`    idle (correct no-op)   ${bar(b.idle, d.total)} ${b.idle}  (${b.no_op_pct}%)`);
  L.push(`    released (engaged)     ${bar(b.released, d.total)} ${b.released}`);
  L.push(`    HELD (rope blocked)    ${bar(b.held, d.total)} ${b.held}`);
  L.push(`    GATED (fall-arrest)    ${bar(b.gated, d.total)} ${b.gated}\n`);

  const fa = ins.fall_arrest;
  if (fa.total_acts) {
    L.push(`  fall-arrest fired ${fa.total_acts} time(s) (journaled):`);
    for (const [cls, n] of Object.entries(fa.by_class).sort((a, b2) => b2[1] - a[1])) L.push(`    ${n}× ${cls}`);
  } else if (ins.pending.count) {
    L.push(`  fall-arrest: 0 journaled (gate-act journaling is new) — but the deferred queue proves it HAS fired:`);
  } else {
    L.push('  fall-arrest: has not fired yet (no irreversible attempted under a focused goal)');
  }
  if (ins.pending.count) L.push(`  ${ins.pending.count} deferred action(s) awaiting review [${ins.pending.classes.join(', ')}] — run \`belay pending\``);

  const r = ins.retros;
  L.push('');
  if (r.count) {
    const oc = Object.entries(r.outcomes).map(([k, v]) => `${v} ${k}`).join(', ');
    L.push(`  loops completed: ${r.count} (${oc}); ${r.thrashed} thrashed; avg ${r.avg_continuations ?? '?'} continuations`);
  } else {
    L.push('  loops completed: none disarmed yet (retros land on stand-down)');
  }
  L.push(`  live now: ${ins.loops.armed} armed, ${ins.loops.paused} paused · ${ins.proposals_open} open proposals`);
  return L.join('\n');
}
