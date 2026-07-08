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

// ── canonical loops (ADR-31): a superseded goal-chain renders as ONE entry, not ×N ──────

test('canonical loops: openkakushin-recomp + openkakushin-recomp-v2 collapse to ONE entry via the automatic -vN stem heuristic', () => {
  const h = homes();
  const v1 = goal({ id: 'goal_v1', slug: 'openkakushin-recomp' });
  const v2 = goal({ id: 'goal_v2', slug: 'openkakushin-recomp-v2' });
  writeKeyoku(h, { goals: [v1, v2] });
  writeLoops(h, {
    goal_v1: { session_id: 's1', armed_at: nowSec() - 300 },
    goal_v2: { session_id: 's1', armed_at: nowSec() - 10 }, // newer → represents the group
  });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⟳ loop openkakushin-recomp-v2'); // ONE entry, not '⟳ loop ×2'
});

test('canonical loops: explicit --canonical key groups two DIFFERENTLY-NAMED slugs into one entry', () => {
  const h = homes();
  writeKeyoku(h, { goals: [gX(), gY()] });
  writeLoops(h, {
    goal_x: { session_id: 's1', canonical: 'shared-migration', armed_at: nowSec() - 300 },
    goal_y: { session_id: 's1', canonical: 'shared-migration', armed_at: nowSec() - 10 },
  });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⟳ loop goal-y'); // no shared slug stem, but the explicit key still collapses them
});

test('canonical loops: genuinely DISTINCT loops (no shared key, no shared -vN stem) stay separate → "×2"', () => {
  const h = homes();
  const a = goal({ id: 'goal_a', slug: 'foo-recomp' });
  const b = goal({ id: 'goal_b', slug: 'bar-recomp' });
  writeKeyoku(h, { goals: [a, b] });
  writeLoops(h, { goal_a: { session_id: 's1' }, goal_b: { session_id: 's1' } });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⟳ loop ×2'); // two DISTINCT canonical keys → still counted separately
});

test('canonical loops: an ALL-PAUSED canonical group collapses to ONE paused entry (⏸, not ×2)', () => {
  const h = homes();
  const v1 = goal({ id: 'goal_v1', slug: 'openkakushin-recomp' });
  const v2 = goal({ id: 'goal_v2', slug: 'openkakushin-recomp-v2' });
  writeKeyoku(h, { goals: [v1, v2] });
  writeLoops(h, {
    goal_v1: { session_id: 's1', paused: true, armed_at: nowSec() - 300 },
    goal_v2: { session_id: 's1', paused: true, armed_at: nowSec() - 10 },
  });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⏸ loop openkakushin-recomp-v2');
});

test('canonical loops: within ONE group, an active member + a paused sibling collapse to the single ACTIVE representative (no spurious "+1⏸")', () => {
  const h = homes();
  const v1 = goal({ id: 'goal_v1', slug: 'openkakushin-recomp' });
  const v2 = goal({ id: 'goal_v2', slug: 'openkakushin-recomp-v2' });
  writeKeyoku(h, { goals: [v1, v2] });
  writeLoops(h, {
    goal_v1: { session_id: 's1', paused: true, armed_at: nowSec() - 300 },
    goal_v2: { session_id: 's1', paused: false, armed_at: nowSec() - 10 },
  });
  const r = statusline(h, { session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '⟳ loop openkakushin-recomp-v2'); // NOT '(+1⏸)' — the paused sibling is the SAME logical loop
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
