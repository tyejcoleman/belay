import { join } from 'node:path';
import { readJSON, readConfig, fmtClock } from './util.mjs';
import { keyokuHome, readKeyoku, goalSlug, unmetDetail } from './keyoku.mjs';
import { readBudget } from './budget.mjs';
import { readOwnState, sessionEntry } from './state.mjs';
import { decideStop } from './stop.mjs';

/** `conductor status` — current focused goal + the would-block verdict + counters.
 *  Evaluates the SAME decision function the Stop hook runs, from the focus's own scope
 *  (so a session-pinned focus is judged as that session would be). Read-only. */
export function status() {
  const focus = readJSON(join(keyokuHome(), 'focus.json'));
  const payload = {
    session_id: typeof focus?.sessionId === 'string' && focus.sessionId ? focus.sessionId : 'status-probe',
    cwd: typeof focus?.cwd === 'string' && focus.cwd ? focus.cwd : process.cwd(),
    stop_hook_active: false,
  };
  const k = readKeyoku({ sessionId: payload.session_id, cwd: payload.cwd });
  const { cfg } = readConfig();
  const budget = readBudget(payload.session_id);

  console.log(`conductor status (keyoku: ${k.home})`);
  if (!k.present) return console.log('  keyoku home not found — conductor idles');
  if (k.paused) return console.log("  'paused' marker present — conductor is a no-op");
  if (!k.focus) return console.log('  no focused goal — conductor idles');

  const own = readOwnState();
  const entry = sessionEntry(own, payload.session_id, k.goal?.id ?? null);
  const d = decideStop(payload, k, budget, cfg, entry);

  if (k.goal) {
    const g = k.goal;
    console.log(`  focus: '${goalSlug(g, k.focus)}' (${g.id})`);
    console.log(`    status ${g.status} · autonomy ${g.autonomy} · iterations ${g.usedIterations ?? '?'}/${g.maxIterations ?? '?'}`);
    const unmet = unmetDetail(g, k.obs);
    console.log(`    unmet: ${unmet == null ? 'unknown (no assessment observation)' : unmet.length ? unmet.join('; ') : 'none'}`);
    console.log(`    last observation at: ${k.obs?.at ?? 'never'}${g.lastAssessedAt ? ` · lastAssessedAt: ${g.lastAssessedAt}` : ''}`);
  } else {
    console.log(`  focus: ${k.focus.goalId} — ${k.matched ? 'goal row not found in goals.json' : 'out of scope from here'}`);
  }

  if (budget.known) {
    console.log(`  budget: 5h ${Math.round(budget.left_pct)}% left${budget.resets_at ? `, resets ${fmtClock(budget.resets_at)}` : ''}${budget.est_tokens_left != null ? ` (≈${Math.round(budget.est_tokens_left / 1000)}k tokens)` : ''}`);
  } else if (budget.stale) {
    console.log(`  budget: UNKNOWN (tokenroom state stale; last known ${Math.round(budget.last_known_left)}% left)`);
  } else {
    console.log('  budget: UNKNOWN (no fresh tokenroom state)');
  }
  if (budget.alt) console.log(`  alt profile: '${budget.alt.label}' ≈${Math.round(budget.alt.left_pct)}% left (fresh)`);

  console.log(`  counters: ${entry.continuations}/${cfg.max_continuations} continuations · stale-block ${entry.staleBlocked ? 'spent' : 'available'} (session ${payload.session_id})`);
  console.log(`  verdict: would ${d.action.toUpperCase()} (${d.kind})${d.reason ? `\n    reason: ${d.reason}` : ''}${d.note ? `\n    note: ${d.note}` : ''}`);
}
