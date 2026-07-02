import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, readConfig, fmtClock, toEpochSec, sanitizeSlug, capReason, belayDir, ensureDir } from './util.mjs';
import { readKeyoku, goalSlug, unmetDetail } from './keyoku.mjs';
import { readBudget } from './budget.mjs';
import { readOwnState, sessionEntry, saveSessionEntry } from './state.mjs';
import { readLoops } from './loops.mjs';

// The Stop hook: hold the session open while the focused Keyoku goal is unconverged,
// the goal is AUTONOMOUS (ADR-2: observe/suggest/approve all imply a human in the loop),
// and budget allows. Everything else — including every parse failure — allows the stop
// silently: belay must be a no-op for normal interactive use (ADR-4).

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The budget clause appended to a block reason. Empty when budget is UNKNOWN
 *  (permissive for stop decisions — never invent a figure). */
export function budgetLine(b, cfg) {
  const parts = [];
  if (b.known && b.left_pct != null) {
    const pct = Math.round(b.left_pct);
    if (b.left_pct < cfg.thin_budget_pct) {
      parts.push(`budget thin (${pct}% left${b.resets_at ? `, resets ${fmtClock(b.resets_at)}` : ''}) — smallest atomic step, checkpoint, then defer via plan_resume if it can't land`);
      if (b.alt) parts.push(`profile '${sanitizeSlug(b.alt.label, 32)}' has ≈${Math.round(b.alt.left_pct)}% — finishing move here, then suggest the user switch`); // label is tokenroom-file-controlled (ADR-7)
    } else {
      parts.push(`5h: ${pct}% left`);
    }
  }
  return parts.length ? ` ${parts.join('; ')}.` : '';
}

/**
 * Pure decision (also driven by `belay status` for the would-block verdict).
 * Returns { action: 'allow'|'block', kind, reason?, note?, save?, entry? } —
 * `note` goes to stderr (observability, never harness-visible context), `reason`
 * to stdout as the block JSON, `entry` is the mutated counter record to persist.
 *
 * `loops` = the loops.json map (injectable for tests); when not passed, the ONE extra
 * defensive file read happens here (§3.2: ~0.1ms, only reached once a focused matched
 * goal exists), so the hook and compose.mjs's 5-arg call return the same verdict.
 * Absent/malformed loops.json → {} → today's decision table exactly (ADR-4).
 */
export function decideStop(_p, k, budget, cfg, entry, nowSec = Date.now() / 1000, loops = null) {
  // `_p` (the stop payload) is deliberately unconsulted since ADR-6 dropped the
  // stop_hook_active branch — kept first-positional for signature stability (hook,
  // compose.mjs, status.mjs and the tests all pass it).
  // ADR-6: we no longer blanket-allow on Claude Code's stop_hook_active guard — that
  // capped the loop at ONE forced continuation per turn (making max_continuations
  // unreachable) and let the one-shot stale-block consume it. We deliberately do NOT reset
  // counters on the flag either: termination must not depend on the harness ever setting
  // stop_hook_active (ADR-4 — never wedge a session). Instead belay's OWN monotonic,
  // durable per-(session, goal) continuation budget bounds the loop deterministically for
  // ANY sequence of stops — see the ADR-6 termination argument. Every stop is now
  // evaluated; stop_hook_active is not consulted here.
  if (!k.present) return { action: 'allow', kind: 'keyoku-absent' };
  if (k.paused) return { action: 'allow', kind: 'paused' };
  if (!k.focus) return { action: 'allow', kind: 'no-focus' };
  if (!k.matched) return { action: 'allow', kind: 'scope-mismatch' };
  if (!k.goal) return { action: 'allow', kind: 'goal-missing' };

  const g = k.goal;
  const slug = sanitizeSlug(goalSlug(g, k.focus)); // slug lands in a model-visible reason (ADR-7)

  // ADR-12: a paused loop releases the ROPE only — an unconditional allow, so the ADR-6
  // termination argument is untouched (blocks remain the two capped paths). The PreToolUse
  // arrest never consults loops.json; only disarm (unfocus) deactivates it.
  if (((loops ?? readLoops().loops)[g.id] ?? {}).paused === true) {
    return { action: 'allow', kind: 'loop-paused', note: `[belay] loop for goal '${slug}' is paused (belay_loop_resume to re-arm) — allowing stop` };
  }

  if (g.status === 'converged') return { action: 'allow', kind: 'converged', note: `[belay] goal '${slug}' converged — nothing to hold` };
  if (g.status !== 'active') return { action: 'allow', kind: `goal-${g.status}` }; // blocked / abandoned / anything future
  if (g.autonomy !== 'autonomous') return { action: 'allow', kind: 'not-autonomous' }; // ADR-2

  // Keyoku's own iteration budget: once exhausted, keyoku refuses further iterations —
  // continuing would spin without the harness recording progress.
  const used = num(g.usedIterations);
  const max = num(g.maxIterations);
  if (used != null && max != null && max > 0 && used >= max) {
    return { action: 'allow', kind: 'iterations-exhausted', note: `[belay] goal '${slug}': keyoku iteration budget exhausted (${used}/${max}) — allowing stop` };
  }

  // Quota-dead with no fresh alternate profile is the ONE legit stop (descent).
  if (budget.known && budget.left_pct != null && budget.left_pct < cfg.budget_floor_pct && !budget.alt) {
    return {
      action: 'allow',
      kind: 'budget-floor',
      note: `[belay] goal '${slug}' unconverged, but the 5h window is below the ${cfg.budget_floor_pct}% floor (${Math.round(budget.left_pct)}% left${budget.resets_at ? `, resets ${fmtClock(budget.resets_at)}` : ''}) with no fresh alternate profile — allowing stop (descent)`,
    };
  }

  // Stale ground truth: block ONCE demanding a goal_assess (counted separately from
  // continuations), then allow — never loop an agent on data nobody re-verified.
  const freshCandidates = [toEpochSec(g.lastAssessedAt), toEpochSec(k.obs?.at)].filter((t) => t != null);
  const freshAt = freshCandidates.length ? Math.max(...freshCandidates) : null;
  const stale = freshAt == null || nowSec - freshAt > cfg.stale_assess_min * 60;
  if (stale) {
    if (entry.staleBlocked) return { action: 'allow', kind: 'stale-spent', note: `[belay] goal '${slug}' state still stale after the one stale-block — allowing stop` };
    const age = freshAt == null ? 'never assessed' : `last assessed ${Math.round((nowSec - freshAt) / 60)}m ago`;
    return {
      action: 'block',
      kind: 'stale-block',
      save: true,
      entry: { ...entry, staleBlocked: true },
      reason: capReason(`[belay] goal '${slug}' state is stale (${age}) — run goal_assess first to get ground truth, then act on the fresh verdict (never claim convergence without it).`),
    };
  }

  const unmetRaw = unmetDetail(g, k.obs);
  // Fresh attestation over an OLDER tail (refute L1-2): keyoku persists goals.json (the
  // fresh lastAssessedAt) BEFORE the best-effort observation append, and append failures
  // are swallowed — so a fresh lastAssessedAt can vouch for tail content that predates
  // it (e.g. a months-old convergence `unmet:[]` line releasing the hold on stale ground
  // truth). Same-run writes land obs.at AFTER lastAssessedAt (ms apart, one process), so
  // an obs older than the assess minus a small slack means THIS assess's observation
  // never landed: the content is UNKNOWN, not fresh.
  const OBS_ATTEST_SLACK_SEC = 5;
  const assessedAt = toEpochSec(g.lastAssessedAt);
  const obsAt = toEpochSec(k.obs?.at);
  const tailPredates = unmetRaw != null && assessedAt != null && obsAt != null && obsAt < assessedAt - OBS_ATTEST_SLACK_SEC;
  const unmet = tailPredates ? null : unmetRaw;
  // unmetDetail's null-vs-[] contract (keyoku.mjs): null = UNKNOWN (no readable assessment
  // observation), [] = affirmatively nothing unmet. We've already passed the stale check,
  // so freshAt is fresh — a fresh goal with NO readable (or no ATTESTED, L1-2) assessment
  // must NOT be silently released. Block once demanding a goal_assess, reusing the
  // one-shot staleBlocked guard so it can't loop (ADR-7 flow).
  if (unmet == null) {
    if (entry.staleBlocked) {
      return { action: 'allow', kind: 'unmet-unknown-spent', note: `[belay] goal '${slug}' still has no readable assessment after the one goal_assess block — allowing stop` };
    }
    return {
      action: 'block',
      kind: 'unmet-unknown',
      save: true,
      entry: { ...entry, staleBlocked: true },
      reason: capReason(
        (tailPredates
          ? `[belay] goal '${slug}' was assessed recently but its assessment observation never landed (the tail predates lastAssessedAt) — run goal_assess to re-establish ground truth before stopping (never claim convergence without it).`
          : `[belay] goal '${slug}' has no readable assessment observation — run goal_assess to get ground truth before stopping (never claim convergence without it).`) + budgetLine(budget, cfg)
      ),
    };
  }
  if (unmet.length === 0) return { action: 'allow', kind: 'nothing-unmet' }; // fresh and nothing unmet → nothing to hold

  // Own continuation budget on top of the harness guard: per (session, goal).
  if (entry.continuations >= cfg.max_continuations) {
    return {
      action: 'allow',
      kind: 'continuations-exhausted',
      note: `[belay] continuation budget exhausted for goal '${slug}' (${entry.continuations}/${cfg.max_continuations} this session) — allowing stop`,
    };
  }

  // The unmet items are already per-item sanitized (keyoku.unmetDetail); cap the joined
  // list and the whole reason so a goal with a huge criteria set can't flood context (ADR-7).
  const unmetStr = capReason(unmet.join('; '), 1200);
  return {
    action: 'block',
    kind: 'block',
    save: true,
    entry: { ...entry, continuations: entry.continuations + 1 },
    reason: capReason(
      `[belay] goal '${slug}' not converged — unmet: ${unmetStr}. ` +
        `Continue working toward these criteria; when you believe one now passes, run goal_assess to verify (never claim convergence without it).` +
        budgetLine(budget, cfg)
    ),
  };
}

/** Append-only Stop-decision journal (~/.belay/decisions.jsonl): one line per evaluated
 *  stop, INCLUDING silent allows — a stop that should have blocked but didn't is otherwise
 *  undiagnosable after the fact (the 2026-07-02 unexplained allow). Self-capping: rewritten
 *  to the newest half at ~512KB. Observability only — must never wedge a stop (ADR-4). */
export function journalStop(payload, kind, action, goalId = null) {
  try {
    ensureDir(belayDir());
    const path = join(belayDir(), 'decisions.jsonl');
    try {
      if (statSync(path).size > 512 * 1024) {
        const lines = readFileSync(path, 'utf8').split('\n');
        writeFileSync(path, lines.slice(Math.floor(lines.length / 2)).join('\n'), { mode: 0o600 });
      }
    } catch {
      // no journal yet — the append below creates it
    }
    const line = {
      at: new Date().toISOString(),
      session_id: typeof payload.session_id === 'string' ? payload.session_id.slice(0, 8) : null,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      goal: typeof goalId === 'string' ? goalId : null,
      action,
      kind,
    };
    appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 });
  } catch {
    // ANY error = skip the journal line, never the stop decision
  }
}

export async function hookStop() {
  const p = await readStdin();
  // bin already wraps hooks in a choke-point try/catch; this inner one keeps the
  // never-crash rule local too (ADR-4) — a Stop hook error would wedge the harness.
  try {
    // No stop_hook_active fast-exit anymore (ADR-6): mid-chain stops must be evaluated
    // so the continuation budget can accumulate and eventually allow. decideStop resets
    // the budget on a FRESH chain and bounds it on mid-chain stops.
    const k = readKeyoku({ sessionId: p.session_id, cwd: p.cwd });
    if (!k.present || k.paused || !k.focus || !k.matched || !k.goal) {
      const kind = !k.present ? 'keyoku-absent' : k.paused ? 'paused' : !k.focus ? 'no-focus' : !k.matched ? 'scope-mismatch' : 'goal-missing';
      journalStop(p, kind, 'allow', k.focus?.goalId ?? null);
      return;
    }
    const { cfg } = readConfig();
    const own = readOwnState();
    const entry = sessionEntry(own, p.session_id, k.goal.id);
    const budget = readBudget(p.session_id);
    const d = decideStop(p, k, budget, cfg, entry);
    if (d.save && d.entry) saveSessionEntry(own, p.session_id, d.entry);
    journalStop(p, d.kind, d.action, k.goal.id);
    if (d.note) process.stderr.write(d.note + '\n');
    if (d.action === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }));
  } catch {
    // ANY error = silent exit 0: a hook must never break the harness
  }
}
