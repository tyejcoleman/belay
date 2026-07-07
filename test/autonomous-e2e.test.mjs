import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeTokenroom, stopPayload, toolPayload, nowSec, iso } from './helpers.mjs';

// ── THE AUTONOMOUS PROOF ──────────────────────────────────────────────────────
// End-to-end, spawn-based, ZERO live state (temp KEYOKU_HOME + TOKENROOM_DIR + BELAY_DIR):
// a focused `autonomous` goal drives the agent to keep working until convergence — the Stop
// hook CONTINUES the loop while a criterion is unmet, STOPS it at convergence, is provably
// BOUNDED, and the PreToolUse guardrail still holds even in autonomous mode.

const stop = (h, over) => run(h, ['hook', 'stop'], stopPayload({ session_id: 's1', cwd: '/tmp/proj', ...over }));
const gate = (h, over) => run(h, ['hook', 'pre-tool-use'], toolPayload({ session_id: 's1', cwd: '/tmp/proj', ...over }));

// A focused, autonomous goal with 2 machine-checkable criteria, scoped to session s1 @ /tmp/proj.
const AUTONOMOUS_GOAL = (over = {}) =>
  goal({
    id: 'goal_ship',
    slug: 'ship-feature',
    autonomy: 'autonomous',
    status: 'active',
    criteria: [
      { id: 'c1', description: 'unit tests green' },
      { id: 'c2', description: 'deployed to staging' },
    ],
    // matches the helpers obs() default at (now-120): real keyoku appends the observation
    // AFTER saving lastAssessedAt, so a tail OLDER than the assess is the L1-2 anomaly —
    // not a healthy world this proof should seed.
    lastAssessedAt: iso(nowSec() - 120),
    ...over,
  });
const FOCUS = () => focusFor({ goalId: 'goal_ship', goalSlug: 'ship-feature', sessionId: 's1', cwd: '/tmp/proj' });
const OBS = (over) => obs({ goalId: 'goal_ship', ...over });

test('AUTONOMOUS LOOP — the goal drives the agent to keep working, then stops at convergence', () => {
  const h = homes();
  // (1) seed: 1 of 2 criteria unmet (c2 still open), fresh assessment, healthy budget
  writeKeyoku(h, { goals: [AUTONOMOUS_GOAL()], focus: FOCUS(), obsLines: [OBS({ unmet: ['c2'], summary: '1 of 2 criteria unmet' })] });
  writeTokenroom(h, { leftPct: 68 });

  // (2) the agent tries to stop → belay BLOCKS and re-prompts toward the unmet criterion.
  const cont = stop(h);
  assert.equal(cont.status, 0);
  const block = JSON.parse(cont.stdout);
  assert.equal(block.decision, 'block', 'loop must CONTINUE while a criterion is unmet');
  assert.match(block.reason, /goal 'ship-feature' not converged/);
  assert.match(block.reason, /unmet: c2: deployed to staging/); // re-prompts toward the OPEN criterion
  assert.match(block.reason, /run goal_assess to verify \(never claim convergence without it\)/);
  assert.match(block.reason, /5h: 68% left/);
  // the continuation was recorded for this (session, goal)
  assert.equal(JSON.parse(readFileSync(join(h.belay, 'state.json'), 'utf8')).sessions.s1.continuations, 1);

  // (3) flip to convergence: goal status converged + observation says 0 unmet →
  //     the SAME stop now ALLOWS (loop STOPS — nothing left to hold).
  writeKeyoku(h, { goals: [AUTONOMOUS_GOAL({ status: 'converged' })], focus: FOCUS(), obsLines: [OBS({ unmet: [], summary: 'all criteria met' })] });
  const done = stop(h);
  assert.equal(done.status, 0);
  assert.equal(done.stdout, '', 'converged goal must ALLOW the stop (no block JSON)');
  assert.match(done.stderr, /goal 'ship-feature' converged(?: in [^—]+)? — nothing to hold/);
});

test('BOUNDED — a non-converging autonomous goal is released after max_continuations (no infinite loop)', () => {
  const h = homes();
  writeKeyoku(h, { goals: [AUTONOMOUS_GOAL()], focus: FOCUS(), obsLines: [OBS({ unmet: ['c1', 'c2'] })] });
  writeTokenroom(h, { leftPct: 68 });
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'config.json'), JSON.stringify({ max_continuations: 4 }));

  // criteria NEVER become met — belay must still let go after the cap, for ANY stop sequence
  // (mid-chain stop_hook_active:true is ignored by ADR-6; the counter is monotonic & durable).
  let blocks = 0;
  for (let i = 0; i < 4; i++) {
    const r = stop(h, { stop_hook_active: i > 0 });
    assert.equal(JSON.parse(r.stdout).decision, 'block', `stop #${i + 1} should still be within budget`);
    blocks++;
  }
  assert.equal(blocks, 4);
  // the 5th stop hits the cap → ALLOW (the worst-case backstop that guarantees release)
  const released = stop(h, { stop_hook_active: true });
  assert.equal(released.stdout, '', 'must ALLOW once the continuation budget is exhausted');
  assert.match(released.stderr, /continuation budget exhausted for goal 'ship-feature' \(4\/4 this session\)/);
  // monotonic: even a "fresh" stop stays released (termination can't be reset by the harness)
  assert.equal(stop(h, { stop_hook_active: false }).stdout, '');
});

test('GUARDRAIL — even under an autonomous goal, an irreversible `git push` still asks the human', () => {
  const h = homes();
  writeKeyoku(h, { goals: [AUTONOMOUS_GOAL()], focus: FOCUS(), obsLines: [OBS({ unmet: ['c2'] })] });
  writeTokenroom(h, { leftPct: 68 });

  const r = gate(h, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'ask', 'autonomy inside the workspace is not autonomy over the world');
  assert.equal(out.permissionDecisionReason, "[belay] 'git push' action under autonomous goal — requires human approval (goal constraint policy)");

  // a plain in-workspace command under the same autonomous goal passes untouched
  assert.equal(gate(h, { tool_input: { command: 'npm test' } }).stdout, '', 'ordinary work is never policed');
});
