import { readStdin, readConfig, fmtClock, toEpochSec } from './util.mjs';
import { readKeyoku, goalSlug, unmetDetail } from './keyoku.mjs';
import { readBudget } from './budget.mjs';
import { readOwnState, sessionEntry, saveSessionEntry } from './state.mjs';

// The Stop hook: hold the session open while the focused Keyoku goal is unconverged,
// the goal is AUTONOMOUS (ADR-2: observe/suggest/approve all imply a human in the loop),
// and budget allows. Everything else — including every parse failure — allows the stop
// silently: conductor must be a no-op for normal interactive use (ADR-4).

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The budget clause appended to a block reason. Empty when budget is UNKNOWN
 *  (permissive for stop decisions — never invent a figure). */
export function budgetLine(b, cfg) {
  const parts = [];
  if (b.known && b.left_pct != null) {
    const pct = Math.round(b.left_pct);
    if (b.left_pct < cfg.thin_budget_pct) {
      parts.push(`budget thin (${pct}% left${b.resets_at ? `, resets ${fmtClock(b.resets_at)}` : ''}) — smallest atomic step, checkpoint, then defer via plan_resume if it can't land`);
      if (b.alt) parts.push(`profile '${b.alt.label}' has ≈${Math.round(b.alt.left_pct)}% — finishing move here, then suggest the user switch`);
    } else {
      parts.push(`5h: ${pct}% left`);
    }
  }
  return parts.length ? ` ${parts.join('; ')}.` : '';
}

/**
 * Pure decision (also driven by `conductor status` for the would-block verdict).
 * Returns { action: 'allow'|'block', kind, reason?, note?, save?, entry? } —
 * `note` goes to stderr (observability, never harness-visible context), `reason`
 * to stdout as the block JSON, `entry` is the mutated counter record to persist.
 */
export function decideStop(p, k, budget, cfg, entry, nowSec = Date.now() / 1000) {
  // Claude Code's own infinite-loop guard: this stop already came from a hook
  // continuation. ALWAYS respect it.
  if (p.stop_hook_active === true) return { action: 'allow', kind: 'stop-hook-active' };
  if (!k.present) return { action: 'allow', kind: 'keyoku-absent' };
  if (k.paused) return { action: 'allow', kind: 'paused' };
  if (!k.focus) return { action: 'allow', kind: 'no-focus' };
  if (!k.matched) return { action: 'allow', kind: 'scope-mismatch' };
  if (!k.goal) return { action: 'allow', kind: 'goal-missing' };

  const g = k.goal;
  const slug = goalSlug(g, k.focus);
  if (g.status === 'converged') return { action: 'allow', kind: 'converged', note: `[conductor] goal '${slug}' converged — nothing to hold` };
  if (g.status !== 'active') return { action: 'allow', kind: `goal-${g.status}` }; // blocked / abandoned / anything future
  if (g.autonomy !== 'autonomous') return { action: 'allow', kind: 'not-autonomous' }; // ADR-2

  // Keyoku's own iteration budget: once exhausted, keyoku refuses further iterations —
  // continuing would spin without the harness recording progress.
  const used = num(g.usedIterations);
  const max = num(g.maxIterations);
  if (used != null && max != null && max > 0 && used >= max) {
    return { action: 'allow', kind: 'iterations-exhausted', note: `[conductor] goal '${slug}': keyoku iteration budget exhausted (${used}/${max}) — allowing stop` };
  }

  // Quota-dead with no fresh alternate profile is the ONE legit stop (descent).
  if (budget.known && budget.left_pct != null && budget.left_pct < cfg.budget_floor_pct && !budget.alt) {
    return {
      action: 'allow',
      kind: 'budget-floor',
      note: `[conductor] goal '${slug}' unconverged, but the 5h window is below the ${cfg.budget_floor_pct}% floor (${Math.round(budget.left_pct)}% left${budget.resets_at ? `, resets ${fmtClock(budget.resets_at)}` : ''}) with no fresh alternate profile — allowing stop (descent)`,
    };
  }

  // Stale ground truth: block ONCE demanding a goal_assess (counted separately from
  // continuations), then allow — never loop an agent on data nobody re-verified.
  const freshCandidates = [toEpochSec(g.lastAssessedAt), toEpochSec(k.obs?.at)].filter((t) => t != null);
  const freshAt = freshCandidates.length ? Math.max(...freshCandidates) : null;
  const stale = freshAt == null || nowSec - freshAt > cfg.stale_assess_min * 60;
  if (stale) {
    if (entry.staleBlocked) return { action: 'allow', kind: 'stale-spent', note: `[conductor] goal '${slug}' state still stale after the one stale-block — allowing stop` };
    const age = freshAt == null ? 'never assessed' : `last assessed ${Math.round((nowSec - freshAt) / 60)}m ago`;
    return {
      action: 'block',
      kind: 'stale-block',
      save: true,
      entry: { ...entry, staleBlocked: true },
      reason: `[conductor] goal '${slug}' state is stale (${age}) — run goal_assess first to get ground truth, then act on the fresh verdict (never claim convergence without it).`,
    };
  }

  const unmet = unmetDetail(g, k.obs);
  if (!unmet || unmet.length === 0) return { action: 'allow', kind: 'nothing-unmet' }; // fresh and nothing unmet → nothing to hold

  // Own continuation budget on top of the harness guard: per (session, goal).
  if (entry.continuations >= cfg.max_continuations) {
    return {
      action: 'allow',
      kind: 'continuations-exhausted',
      note: `[conductor] continuation budget exhausted for goal '${slug}' (${entry.continuations}/${cfg.max_continuations} this session) — allowing stop`,
    };
  }

  return {
    action: 'block',
    kind: 'block',
    save: true,
    entry: { ...entry, continuations: entry.continuations + 1 },
    reason:
      `[conductor] goal '${slug}' not converged — unmet: ${unmet.join('; ')}. ` +
      `Continue working toward these criteria; when you believe one now passes, run goal_assess to verify (never claim convergence without it).` +
      budgetLine(budget, cfg),
  };
}

export async function hookStop() {
  const p = await readStdin();
  // bin already wraps hooks in a choke-point try/catch; this inner one keeps the
  // never-crash rule local too (ADR-4) — a Stop hook error would wedge the harness.
  try {
    if (p.stop_hook_active === true) return; // cheapest exit, no file reads
    const k = readKeyoku({ sessionId: p.session_id, cwd: p.cwd });
    if (!k.present || k.paused || !k.focus || !k.matched || !k.goal) return;
    const { cfg } = readConfig();
    const own = readOwnState();
    const entry = sessionEntry(own, p.session_id, k.goal.id);
    const budget = readBudget(p.session_id);
    const d = decideStop(p, k, budget, cfg, entry);
    if (d.save && d.entry) saveSessionEntry(own, p.session_id, d.entry);
    if (d.note) process.stderr.write(d.note + '\n');
    if (d.action === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }));
  } catch {
    // ANY error = silent exit 0: a hook must never break the harness
  }
}
