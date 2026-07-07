import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeTokenroom, stopPayload } from './helpers.mjs';

// ── ADR-23 / B1: milestone-aware early release ──────────────────────────────────
// belay measured progress purely as the unmet-criteria SET changing. A goal whose
// criteria are big MULTI-SESSION MILESTONES makes real progress (commits, goal_records)
// WITHOUT flipping a coarse criterion, so the unmet set stays constant and the ADR-21
// adaptive early-release wrongly RELEASED a productively-advancing loop ("same criteria
// across N assessments → releasing the hold"). Fix: a goal DECLARING a long horizon
// (maxIterations >= cfg.milestone_iterations) suppresses the early-release and leans on
// cfg.max_continuations — the hard per-session backstop — so termination still holds.

const stop = (h, payload) => run(h, ['hook', 'stop'], payload ?? stopPayload());

test('milestone goal (high declared horizon) KEEPS holding past the thrash_release point that RELEASES a normal goal (B1)', () => {
  const cfg = { thrash_threshold: 2, thrash_release: 3, max_continuations: 10, milestone_iterations: 200 };

  // control — an ordinary goal (maxIterations 50 < milestone_iterations) early-releases on the
  // 4th same-unmet assessment (sameUnmetCount 4 > thrash_release 3), far under max_continuations.
  const normal = homes();
  writeKeyoku(normal, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(normal, { leftPct: 72 });
  mkdirSync(normal.belay, { recursive: true });
  writeFileSync(join(normal.belay, 'config.json'), JSON.stringify(cfg));
  for (let i = 0; i < 3; i++) assert.equal(JSON.parse(stop(normal, stopPayload({ stop_hook_active: i > 0 })).stdout).decision, 'block'); // blocks 1..3
  const nr = stop(normal, stopPayload({ stop_hook_active: true })); // 4th assessment → thrash-exhausted release
  assert.equal(nr.stdout, '', 'ordinary goal releases early at the thrash_release point');
  assert.match(nr.stderr, /stalled: same unmet set for 4 assessments/);

  // milestone — IDENTICAL config and IDENTICAL constant unmet set, but maxIterations 1000 >= 200.
  // The early-release is suppressed: the same 4th assessment (and beyond) STILL blocks, because
  // real progress on a multi-session milestone lands without flipping a coarse criterion.
  const ms = homes();
  writeKeyoku(ms, { goals: [goal({ maxIterations: 1000, usedIterations: 40 })], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(ms, { leftPct: 72 });
  mkdirSync(ms.belay, { recursive: true });
  writeFileSync(join(ms.belay, 'config.json'), JSON.stringify(cfg));
  for (let i = 0; i < 4; i++) {
    assert.equal(JSON.parse(stop(ms, stopPayload({ stop_hook_active: i > 0 })).stdout).decision, 'block', `milestone stop ${i + 1} must still hold`);
  }
  // streak kept climbing (constant unmet), but the hold was NOT released where a normal goal would
  const st = JSON.parse(readFileSync(join(ms.belay, 'state.json'), 'utf8'));
  assert.equal(st.sessions.s1.sameUnmetCount, 4);
  assert.equal(st.sessions.s1.continuations, 4);
});

test('a genuinely-stuck MILESTONE loop STILL terminates: max_continuations is the hard per-session backstop (ADR-6 intact)', () => {
  // Adversarial case (constraint 3): the milestone signal must NOT let a no-progress loop run
  // forever. maxIterations is huge so the early-release is off, and the unmet set NEVER changes —
  // yet the loop must still stop, bounded by cfg.max_continuations.
  const cfg = { thrash_threshold: 2, thrash_release: 3, max_continuations: 5, milestone_iterations: 200 };
  const h = homes();
  writeKeyoku(h, { goals: [goal({ maxIterations: 1000, usedIterations: 40 })], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h, { leftPct: 72 });
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'config.json'), JSON.stringify(cfg));

  // stops 1..4 all hold (early-release suppressed for the milestone)…
  for (let i = 0; i < 4; i++) assert.equal(JSON.parse(stop(h, stopPayload({ stop_hook_active: i > 0 })).stdout).decision, 'block', `stop ${i + 1} holds`);
  // …stop 5 is the LAST held block: the wrap-up directive (clean landing), NOT a silent release…
  const b5 = JSON.parse(stop(h, stopPayload({ stop_hook_active: true })).stdout);
  assert.equal(b5.decision, 'block');
  assert.match(b5.reason, /LAST held continuation \(5\/5\)/);
  assert.match(b5.reason, /do NOT claim success/);
  // …stop 6 RELEASES via the per-session cap — termination holds despite zero criterion progress.
  const done = stop(h, stopPayload({ stop_hook_active: true }));
  assert.equal(done.stdout, '', 'a stuck milestone loop still terminates at max_continuations');
  assert.match(done.stderr, /continuation budget exhausted for goal 'ship-widget' \(5\/5 this session\)/);
  // it terminated via the max_continuations backstop, NOT the (suppressed) thrash early-release
  assert.doesNotMatch(done.stderr, /stalled: same unmet set/);
});

test('a genuinely-stuck NON-milestone loop still early-releases (thrash termination path unchanged)', () => {
  // The default horizon (50) is below milestone_iterations, so belay behaves exactly as before:
  // a no-progress loop is released early via thrash-exhausted, well under max_continuations.
  const cfg = { thrash_threshold: 2, thrash_release: 3, max_continuations: 25, milestone_iterations: 200 };
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] }); // maxIterations 50
  writeTokenroom(h, { leftPct: 72 });
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'config.json'), JSON.stringify(cfg));
  for (let i = 0; i < 3; i++) assert.equal(JSON.parse(stop(h, stopPayload({ stop_hook_active: i > 0 })).stdout).decision, 'block');
  const r = stop(h, stopPayload({ stop_hook_active: true })); // 4th → early release
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /stalled: same unmet set for 4 assessments/);
  const st = JSON.parse(readFileSync(join(h.belay, 'state.json'), 'utf8'));
  assert.ok(st.sessions.s1.continuations < 25, `released early, under the cap (got ${st.sessions.s1.continuations})`);
});

test('config: milestone_iterations validates — default 200, override honored, bad value falls back with a warning', async () => {
  const { validateConfig, CONFIG_DEFAULTS } = await import('../src/util.mjs');
  assert.equal(CONFIG_DEFAULTS.milestone_iterations, 200);
  assert.equal(validateConfig(null).cfg.milestone_iterations, 200);
  assert.equal(validateConfig({ milestone_iterations: 1000 }).cfg.milestone_iterations, 1000);
  const bad = validateConfig({ milestone_iterations: 'lots' });
  assert.equal(bad.cfg.milestone_iterations, 200);
  assert.match(bad.warnings.join(' '), /milestone_iterations/);
});
