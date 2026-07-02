import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeTokenroom, writeProfiles, stopPayload, nowSec, iso } from './helpers.mjs';

// T1: every Stop-hook decision branch, spawning the real bin against synthetic
// KEYOKU_HOME / TOKENROOM_DIR / CONDUCTOR_DIR fixtures.

const stop = (h, payload) => run(h, ['hook', 'stop'], payload ?? stopPayload());

test('focused autonomous goal + unmet + healthy budget → block JSON with unmet detail and budget line', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h, { leftPct: 72 });
  const r = stop(h);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^\[conductor\] goal 'ship-widget' not converged — unmet: c1: tests green; c2: deployed to prod\./);
  assert.match(out.reason, /run goal_assess to verify \(never claim convergence without it\)/);
  assert.match(out.reason, /5h: 72% left\.$/);

  // the block incremented the per-(session,goal) counter, with owner-only perms
  const st = JSON.parse(readFileSync(join(h.conductor, 'state.json'), 'utf8'));
  assert.equal(st.sessions.s1.continuations, 1);
  assert.equal(st.sessions.s1.goalId, 'goal_test1');
  if (process.platform !== 'win32') {
    assert.equal(statSync(h.conductor).mode & 0o777, 0o700);
    assert.equal(statSync(join(h.conductor, 'state.json')).mode & 0o777, 0o600);
  }
});

test('stop_hook_active === true → always allow (respects Claude Code loop guard)', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h);
  const r = stop(h, stopPayload({ stop_hook_active: true }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('observe / suggest / approve goals never self-continue', () => {
  for (const autonomy of ['observe', 'suggest', 'approve']) {
    const h = homes();
    writeKeyoku(h, { goals: [goal({ autonomy })], focus: focusFor(), obsLines: [obs()] });
    writeTokenroom(h);
    const r = stop(h);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', `autonomy=${autonomy} must allow stop`);
  }
});

test('no focus / keyoku absent / paused → exit silently', () => {
  const noFocus = homes();
  writeKeyoku(noFocus, { goals: [goal()] });
  assert.equal(stop(noFocus).stdout, '');

  const absent = homes(); // keyoku dir never created
  assert.equal(stop(absent).stdout, '');

  const paused = homes();
  writeKeyoku(paused, { goals: [goal()], focus: focusFor(), obsLines: [obs()], paused: true });
  assert.equal(stop(paused).stdout, '');
});

test('scope: sessionId mismatch and cwd outside the subtree → not ours, allow', () => {
  const bySession = homes();
  writeKeyoku(bySession, { goals: [goal()], focus: focusFor({ sessionId: 'someone-else' }), obsLines: [obs()] });
  assert.equal(stop(bySession).stdout, '');

  const byCwd = homes();
  writeKeyoku(byCwd, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  assert.equal(stop(byCwd, stopPayload({ cwd: '/tmp/other-project' })).stdout, '');

  // session cwd INSIDE the focus subtree still matches (the one direction we keep)
  const child = homes();
  writeKeyoku(child, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(child);
  assert.match(JSON.parse(stop(child, stopPayload({ cwd: '/tmp/proj/packages/core' })).stdout).reason, /not converged/);
});

test('scope one-way (ADR-5): an ANCESTOR / "/" / "$HOME" session is NOT held by a deeper focus', () => {
  // focus is pinned deep inside a repo; the stopping session runs at an ANCESTOR dir
  // (an orchestrator at the repo root). The OLD bidirectional match blocked it — wrong.
  const ancestor = homes();
  writeKeyoku(ancestor, { goals: [goal()], focus: focusFor({ cwd: '/tmp/proj/packages/core' }), obsLines: [obs()] });
  writeTokenroom(ancestor);
  assert.equal(stop(ancestor, stopPayload({ cwd: '/tmp/proj' })).stdout, '', 'ancestor session must not be held');

  // a session sitting at "/" must never be matched by any cwd-scoped focus
  const root = homes();
  writeKeyoku(root, { goals: [goal()], focus: focusFor({ cwd: '/tmp/proj' }), obsLines: [obs()] });
  writeTokenroom(root);
  assert.equal(stop(root, stopPayload({ cwd: '/' })).stdout, '', 'session at / must not be held');

  // a focus pinned at "/" (strips to "") must not match every session
  const rootFocus = homes();
  writeKeyoku(rootFocus, { goals: [goal()], focus: focusFor({ cwd: '/' }), obsLines: [obs()] });
  writeTokenroom(rootFocus);
  assert.equal(stop(rootFocus, stopPayload({ cwd: '/tmp/proj' })).stdout, '', 'focus at / must not match everything');
});

test('converged → allow with stderr one-liner; blocked/abandoned → silent allow', () => {
  const conv = homes();
  writeKeyoku(conv, { goals: [goal({ status: 'converged' })], focus: focusFor(), obsLines: [obs({ unmet: [] })] });
  const r = stop(conv);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /goal 'ship-widget' converged — nothing to hold/);

  for (const status of ['blocked', 'abandoned']) {
    const h = homes();
    writeKeyoku(h, { goals: [goal({ status })], focus: focusFor(), obsLines: [obs()] });
    const rr = stop(h);
    assert.equal(rr.stdout, '');
    assert.doesNotMatch(rr.stderr, /conductor/);
  }
});

test('continuation counter exhaustion → allow with stderr note; counter resets on goal change', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h);
  mkdirSync(h.conductor, { recursive: true });
  writeFileSync(join(h.conductor, 'state.json'), JSON.stringify({ sessions: { s1: { goalId: 'goal_test1', continuations: 25, staleBlocked: false, updated_at: nowSec() } } }));
  const r = stop(h);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /continuation budget exhausted for goal 'ship-widget' \(25\/25 this session\) — allowing stop/);

  // same session, DIFFERENT goal → counter starts fresh → blocks again
  const g2 = goal({ id: 'goal_test2', slug: 'other-goal' });
  writeKeyoku(h, { goals: [g2], focus: focusFor({ goalId: 'goal_test2', goalSlug: 'other-goal' }), obsLines: [obs({ goalId: 'goal_test2' })] });
  const r2 = stop(h);
  assert.match(JSON.parse(r2.stdout).reason, /goal 'other-goal' not converged/);
  assert.equal(JSON.parse(readFileSync(join(h.conductor, 'state.json'), 'utf8')).sessions.s1.continuations, 1);
});

test('stale assessment → exactly one "run goal_assess" block, then allow', () => {
  const h = homes();
  const old = iso(nowSec() - 2 * 3600); // 2h > default 60m stale_assess_min
  writeKeyoku(h, { goals: [goal({ lastAssessedAt: old })], focus: focusFor(), obsLines: [obs({ at: old })] });
  writeTokenroom(h);

  const first = stop(h);
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /state is stale \(last assessed 120m ago\) — run goal_assess first to get ground truth/);

  const second = stop(h);
  assert.equal(second.stdout, '', 'stale-block is spent — must allow');
  assert.match(second.stderr, /still stale after the one stale-block/);

  // the stale-block did NOT consume a continuation
  assert.equal(JSON.parse(readFileSync(join(h.conductor, 'state.json'), 'utf8')).sessions.s1.continuations, 0);
});

test('never-assessed goal (no lastAssessedAt, no observations) takes the stale path', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal({ lastAssessedAt: undefined })], focus: focusFor() });
  writeTokenroom(h);
  const out = JSON.parse(stop(h).stdout);
  assert.match(out.reason, /state is stale \(never assessed\) — run goal_assess first/);
});

test('thin budget wording + alt profile advice', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h, { leftPct: 12 });
  const r1 = JSON.parse(stop(h).stdout);
  assert.match(r1.reason, /budget thin \(12% left, resets \d\d:\d\d\) — smallest atomic step, checkpoint, then defer via plan_resume if it can't land\./);
  assert.doesNotMatch(r1.reason, /profile '/);

  writeProfiles(h, { work: { left_pct: 80, updated_at: nowSec() - 60 } });
  const r2 = JSON.parse(stop(h).stdout);
  assert.match(r2.reason, /budget thin \(12% left/);
  assert.match(r2.reason, /profile 'work' has ≈80% — finishing move here, then suggest the user switch\./);
});

test('budget below floor: no alt → allow stop (descent); fresh alt → keep blocking with switch advice', () => {
  const dead = homes();
  writeKeyoku(dead, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(dead, { leftPct: 2 });
  const r = stop(dead);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /below the 3% floor \(2% left.*\) with no fresh alternate profile — allowing stop \(descent\)/);

  const withAlt = homes();
  writeKeyoku(withAlt, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(withAlt, { leftPct: 2 });
  writeProfiles(withAlt, { work: { left_pct: 80, updated_at: nowSec() - 60 } });
  const out = JSON.parse(stop(withAlt).stdout);
  assert.match(out.reason, /profile 'work' has ≈80% — finishing move here, then suggest the user switch/);

  // a STALE alt profile does not count
  const staleAlt = homes();
  writeKeyoku(staleAlt, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(staleAlt, { leftPct: 2 });
  writeProfiles(staleAlt, { work: { left_pct: 80, updated_at: nowSec() - 2 * 3600 } });
  assert.equal(stop(staleAlt).stdout, '');
});

test('tokenroom absent or stale → budget UNKNOWN → block WITHOUT a budget line (permissive for stop)', () => {
  const absent = homes();
  writeKeyoku(absent, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  const r1 = JSON.parse(stop(absent).stdout);
  assert.equal(r1.decision, 'block');
  assert.match(r1.reason, /without it\)\.$/); // no budget clause appended

  const stale = homes();
  writeKeyoku(stale, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(stale, { leftPct: 2, updatedAgoSec: 45 * 60 }); // stale 2%-left must NOT trigger the floor
  const r2 = JSON.parse(stop(stale).stdout);
  assert.equal(r2.decision, 'block');
  assert.match(r2.reason, /without it\)\.$/);
});

test('keyoku iteration budget exhausted → allow with note', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal({ usedIterations: 50, maxIterations: 50 })], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h);
  const r = stop(h);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /keyoku iteration budget exhausted \(50\/50\)/);
});

test('fresh observation with nothing unmet → allow silently (nothing to hold)', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs({ unmet: [] })] });
  writeTokenroom(h);
  assert.equal(stop(h).stdout, '');
});

test('torn trailing observation line is skipped; unmet ids without criteria fall back to the id', () => {
  const h = homes();
  const g = goal({ criteria: [{ id: 'c1', description: 'tests green' }] }); // c9 has no description
  writeKeyoku(h, { goals: [g], focus: focusFor(), obsLines: [obs({ unmet: ['c1', 'c9'] }), '{"goalId":"goal_test1","unmet":["c1"'] });
  writeTokenroom(h);
  const out = JSON.parse(stop(h).stdout);
  assert.match(out.reason, /unmet: c1: tests green; c9\./);
});

test('corrupted focus.json / goals.json / conductor state / non-JSON stdin → silent allow, exit 0', () => {
  const badFocus = homes();
  writeKeyoku(badFocus, { goals: [goal()], focus: '{"goalId": broken' });
  const r1 = stop(badFocus);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, '');

  const badGoals = homes();
  writeKeyoku(badGoals, { goals: '{[not json', focus: focusFor() });
  const r2 = stop(badGoals);
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, '');

  const badOwn = homes();
  writeKeyoku(badOwn, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(badOwn);
  mkdirSync(badOwn.conductor, { recursive: true });
  writeFileSync(join(badOwn.conductor, 'state.json'), 'not json at all');
  const r3 = stop(badOwn); // corrupted OWN state degrades to zero counters, still blocks
  assert.equal(r3.status, 0);
  assert.equal(JSON.parse(r3.stdout).decision, 'block');

  const badStdin = homes();
  writeKeyoku(badStdin, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  const r4 = run(badStdin, ['hook', 'stop'], 'not json at all');
  assert.equal(r4.status, 0);
  assert.equal(r4.stdout, '');
});

test('config overrides: max_continuations and stale_assess_min honored; bad config falls back to defaults', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h);
  mkdirSync(h.conductor, { recursive: true });
  writeFileSync(join(h.conductor, 'config.json'), JSON.stringify({ max_continuations: 1, stale_assess_min: 'sixty' }));
  assert.equal(JSON.parse(stop(h).stdout).decision, 'block'); // 0 → 1
  const r = stop(h); // 1 >= 1 → exhausted
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /\(1\/1 this session\)/);
});
