import { join } from 'node:path';
import { readJSON, readConfig, fmtClock, belayDir, sanitizeText } from './util.mjs';
import { keyokuHome, readKeyoku, goalSlug, unmetDetail } from './keyoku.mjs';
import { readBudget } from './budget.mjs';
import { readOwnState, sessionEntry } from './state.mjs';
import { decideStop } from './stop.mjs';
import { readLoops } from './loops.mjs';
import { pendingSummary } from './pending.mjs';

/** Open-proposal count straight from proposals.json (ADR-9 posture: a count, never copies;
 *  absent/malformed → 0). `belay propose` / belay_propose carry the full evidence. */
function openProposalCount() {
  const p = readJSON(join(belayDir(), 'proposals.json'));
  return Array.isArray(p?.proposals) ? p.proposals.filter((x) => x && typeof x === 'object' && x.status === 'open').length : 0;
}

/** `belay status` — current focused goal + the would-block verdict + counters, plus the
 *  SOTA surfaces: the goal's loop arm/pause provenance (loops.json) and how many
 *  proposals are open (proposals.json). Evaluates the SAME decision function the Stop
 *  hook runs, from the focus's own scope (so a session-pinned focus is judged as that
 *  session would be). Read-only; every figure comes from a state file. */
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

  console.log(`belay status (keyoku: ${k.home})`);
  const proposalsLine = () => {
    const n = openProposalCount();
    console.log(`  proposals: ${n} open${n ? ' — `belay propose` for evidence + ready-to-arm args (never auto-armed)' : ''}`);
    // ADR-16: deferred-action queue (presentation metadata only — no decision reads it).
    const pend = pendingSummary();
    console.log(`  pending: ${pend.count} deferred${pend.count ? ` [${pend.classes.join(', ')}] — run \`belay pending\` to review` : ''}`);
  };
  if (!k.present) {
    console.log('  keyoku home not found — belay idles');
    return proposalsLine();
  }
  if (k.paused) {
    console.log("  'paused' marker present — belay is a no-op");
    return proposalsLine();
  }
  if (!k.focus) {
    console.log('  no focused goal — belay idles');
    return proposalsLine();
  }

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
    // An unpinned focus of an active autonomous goal ropes ANY session inside its cwd
    // subtree (keyoku.mjs scopeMatch's documented residual hole — it conscripted the
    // orchestrator session live on 2026-07-02). Surface it wherever the human looks.
    if (g.status === 'active' && g.autonomy === 'autonomous' && !(typeof k.focus.sessionId === 'string' && k.focus.sessionId)) {
      console.log(`    warning: focus has no sessionId pin — any session under '${sanitizeText(String(k.focus.cwd ?? ''), 80) || '(any cwd)'}' can be roped by the Stop hold (pass sessionId to goal_focus, or arm via belay_loop_create)`);
    }
    // Loop arm/pause provenance (loops.json — belay's own file). Arming is provenance +
    // counter reset, not a precondition: the Stop hold applies to any focused active
    // autonomous goal regardless (docs/DESIGN.md §3.2).
    const le = readLoops().loops[g.id];
    if (le && typeof le === 'object') {
      const by = sanitizeText(String(le.armed_by ?? 'unknown'), 48); // belay-file-controlled, sanitized anyway (ADR-7 posture)
      const note = typeof le.note === 'string' && le.note ? ` · note: ${sanitizeText(le.note, 80)}` : '';
      if (le.paused === true) {
        console.log(`    loop: PAUSED (armed by ${by}) — stop hold released; the fall-arrest gate stays active while focused (ADR-12) — \`belay loop resume\` to re-arm${note}`);
      } else {
        console.log(`    loop: armed by ${by}${le.armed_at ? ` since ${fmtClock(le.armed_at)}` : ''}${note}`);
      }
    } else {
      console.log('    loop: not armed via belay (the Stop hold applies to any focused active autonomous goal regardless)');
    }
  } else {
    console.log(`  focus: ${k.focus.goalId} — ${k.matched ? 'goal row not found in goals.json' : 'out of scope from here'}`);
  }

  if (budget.known) {
    console.log(`  budget: 5h ${Math.round(budget.left_pct)}% left${budget.resets_at ? `, resets ${fmtClock(budget.resets_at)}` : ''}${budget.est_tokens_left != null ? ` (≈${Math.round(budget.est_tokens_left / 1000)}k tokens)` : ''}`);
  } else if (budget.withheld) {
    console.log('  budget: WITHHELD (unmapped session on a multi-account machine — wrong-account numbers are worse than none)');
  } else if (budget.stale) {
    console.log(`  budget: UNKNOWN (tokenroom state stale; last known ${Math.round(budget.last_known_left)}% left)`);
  } else {
    console.log('  budget: UNKNOWN (no fresh tokenroom state)');
  }
  if (budget.alt) console.log(`  alt profile: '${budget.alt.label}' ≈${Math.round(budget.alt.left_pct)}% left (fresh)`);

  // No fabrication (refute L4-2): with no sessionId pin there is no per-(session,goal)
  // row to read — say so instead of presenting the zero-history default as a figure.
  if (payload.session_id === 'status-probe' && k.goal) {
    console.log(`  counters: unattributed — focus has no sessionId pin; per-session spends unknown (verdict below assumes zero history and can differ from the driving session's)`);
  } else {
    console.log(`  counters: ${entry.continuations}/${cfg.max_continuations} continuations · stale-block ${entry.staleBlocked ? 'spent' : 'available'} (session ${payload.session_id})`);
  }
  console.log(`  verdict: would ${d.action.toUpperCase()} (${d.kind})${d.reason ? `\n    reason: ${d.reason}` : ''}${d.note ? `\n    note: ${d.note}` : ''}`);
  proposalsLine();
}
