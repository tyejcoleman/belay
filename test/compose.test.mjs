import test from 'node:test';
import assert from 'node:assert/strict';
import { homes, goal, focusFor, obs, writeKeyoku } from './helpers.mjs';

// compose.mjs unit tests: belay_status array caps (MCP-F4 context-flood defense) and the
// compaction re-briefing. scan/build functions read env-derived paths at call time, so swap
// them per call.

function withEnv(h, fn) {
  const keys = { KEYOKU_HOME: h.keyoku, TOKENROOM_DIR: h.tokenroom, BELAY_DIR: h.belay, CLAUDE_CONFIG_DIR: h.config };
  const prev = {};
  for (const [k, v] of Object.entries(keys)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const compose = await import('../src/compose.mjs');
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]'); // C0 + DEL + C1 controls

test('belay_status caps the unmet + constraints arrays (MCP-F4 — a torn/hostile tail cannot flood context)', () => {
  const h = homes();
  const ids = Array.from({ length: 300 }, (_, i) => `c${i}`);
  const criteria = ids.map((id) => ({ id, description: `criterion ${id}` }));
  const constraints = Array.from({ length: 300 }, (_, i) => `constraint number ${i}`);
  writeKeyoku(h, { goals: [goal({ criteria, constraints })], focus: focusFor(), obsLines: [obs({ unmet: ids })] });
  const s = withEnv(h, () => compose.buildStatus({ session_id: 's1', cwd: '/tmp/proj' }));
  assert.ok(s.goal.unmet.length <= 51, `unmet not capped: ${s.goal.unmet.length}`);
  assert.match(s.goal.unmet.at(-1), /more truncated/);
  assert.ok(s.goal.constraints.length <= 51, `constraints not capped: ${s.goal.constraints.length}`);
  assert.match(s.goal.constraints.at(-1), /more truncated/);
});

test('buildLoopBriefing returns null when nothing is focused, and a sanitized capped string when a loop is live', () => {
  const idle = homes();
  writeKeyoku(idle, { goals: [goal()] }); // no focus
  assert.equal(withEnv(idle, () => compose.buildLoopBriefing({ session_id: 's1', cwd: '/tmp/proj' })), null);

  const live = homes();
  writeKeyoku(live, { goals: [goal()], focus: focusFor({ sessionId: 's1' }), obsLines: [obs()] });
  const b = withEnv(live, () => compose.buildLoopBriefing({ session_id: 's1', cwd: '/tmp/proj' }));
  assert.match(b, /MID-LOOP on autonomous goal 'ship-widget'/);
  assert.doesNotMatch(b, CONTROL); // ADR-7: control chars stripped
  assert.ok(b.length <= 1200);
});
