import test from 'node:test';
import assert from 'node:assert/strict';
import { homes, run, goal, obs, writeKeyoku, writeLoops, nowSec, iso } from './helpers.mjs';

// `belay statusline` (docs/DECISIONS.md ADR-30): PERSISTENT one-line "loop mode" indicator
// for a Claude Code statusLine command. Read-only, never crashes — every case below asserts
// exitCode 0 alongside the stdout content.

const statusline = (h, payload) => run(h, ['statusline'], payload);

const gX = () => goal({ id: 'goal_x', slug: 'goal-x' });
const gY = () => goal({ id: 'goal_y', slug: 'goal-y' });

test('one owned armed active loop, no readable observation → "⟳ loop <slug>"', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] }); // slug 'ship-widget'
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  const r = statusline(h, { session_id: 's1', cwd: '/tmp/proj' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⟳ loop ship-widget');
});

test('one owned armed active loop WITH a fresh observation → appends met/total', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], obsLines: [obs({ unmet: ['c1'], at: iso(nowSec() - 30) })] }); // 2 criteria, 1 unmet → 1/2
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⟳ loop ship-widget 1/2');
});

test('session owns nothing (no loops.json entry for it) → empty string', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, { goal_test1: { session_id: 'someone-else' } });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('no loops.json at all → empty string', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('owned loop is PAUSED → the paused form "⏸ loop <slug>"', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, { goal_test1: { session_id: 's1', paused: true } });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⏸ loop ship-widget');
});

test('two owned active loops → compact "⟳ loop ×2"', () => {
  const h = homes();
  writeKeyoku(h, { goals: [gX(), gY()] });
  writeLoops(h, { goal_x: { session_id: 's1' }, goal_y: { session_id: 's1' } });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⟳ loop ×2');
});

test('one active + one paused owned loop → active form leads, paused count appended', () => {
  const h = homes();
  writeKeyoku(h, { goals: [gX(), gY()] });
  writeLoops(h, { goal_x: { session_id: 's1' }, goal_y: { session_id: 's1', paused: true } });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⟳ loop goal-x (+1⏸)');
});

test('a non-active (e.g. converged) goal row is not shown even if armed', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal({ status: 'converged' })] });
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('missing session id (no stdin session_id, no $CLAUDE_CODE_SESSION_ID) → empty, no crash', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  const r = statusline(h, { cwd: '/tmp/proj' }); // no session_id in the payload
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('garbage (non-JSON) stdin → empty, no crash, exit 0', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  const r = statusline(h, 'this is not json at all {{{');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('corrupted loops.json → empty, no crash', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, '{ this is not valid json');
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('keyoku home entirely absent → empty, no crash', () => {
  const h = homes();
  writeLoops(h, { goal_test1: { session_id: 's1' } }); // loops.json exists, but goals.json/keyoku home does not
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
