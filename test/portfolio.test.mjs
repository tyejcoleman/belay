import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeLoops, writeTokenroom, stopPayload, nowSec, iso } from './helpers.mjs';

// B3 / ADR-25 — belay as a PER-SESSION GOAL PORTFOLIO orchestrator.
// A session OWNS the armed, non-paused, session_id-pinned loops.json entries whose keyoku
// goal row is active. belay steers the WHOLE owned set: one goal per stop (round-robin),
// allowing only when ALL owned goals are converged/exhausted/paused. A global focus.json
// flip by ANOTHER session (or arming a sibling in THIS session) can never evict a loop.

const stop = (h, payload) => run(h, ['hook', 'stop'], payload);
const readState = (h) => JSON.parse(readFileSync(join(h.belay, 'state.json'), 'utf8'));

const gX = () => goal({ id: 'goal_x', slug: 'goal-x' });
const gY = () => goal({ id: 'goal_y', slug: 'goal-y' });
const gZ = () => goal({ id: 'goal_z', slug: 'goal-z' });
const unmetObs = (goalId) => obs({ goalId, unmet: ['c1'], at: iso(nowSec() - 30) });
const cleanObs = (goalId) => obs({ goalId, unmet: [], at: iso(nowSec() - 30) });

/** Seed a two-goal world where session `sid` owns BOTH goal_x and goal_y (a portfolio). */
function twoGoalPortfolio(h, { xObs = unmetObs('goal_x'), yObs = unmetObs('goal_y'), sid = 'A' } = {}) {
  writeKeyoku(h, { goals: [gX(), gY()], focus: focusFor({ goalId: 'goal_x', goalSlug: 'goal-x' }), obsLines: [xObs] });
  writeKeyoku(h, { obsLines: [yObs] }); // observations/goal_y.jsonl (goals/focus left as-is)
  writeLoops(h, { goal_x: { session_id: sid }, goal_y: { session_id: sid } });
  writeTokenroom(h, { leftPct: 72 });
}

// ── NO-EVICTION (the core B3 property), cross-session, single goal each ───────────────────
test('no-eviction: A steers its goal even after B flips the GLOBAL focus to a different goal', () => {
  const h = homes();
  // A owns goal_x; B owns goal_y. focus.json points at goal_y (B focused last — the singleton).
  writeKeyoku(h, { goals: [gX(), gY()], focus: focusFor({ goalId: 'goal_y', goalSlug: 'goal-y', sessionId: 'B' }), obsLines: [unmetObs('goal_x')] });
  writeKeyoku(h, { obsLines: [unmetObs('goal_y')] });
  writeLoops(h, { goal_x: { session_id: 'A' }, goal_y: { session_id: 'B' } });
  writeTokenroom(h, { leftPct: 72 });

  // A's stop resolves goal_x from ITS OWN loop — the global focus=goal_y does NOT evict it.
  const a = JSON.parse(stop(h, stopPayload({ session_id: 'A', cwd: '/tmp/proj' })).stdout);
  assert.equal(a.decision, 'block');
  assert.match(a.reason, /goal 'goal-x' not converged/);
  assert.doesNotMatch(a.reason, /\[belay portfolio\]/); // exactly one owned goal → single path, no portfolio suffix

  // B's stop steers goal_y concurrently — both sessions hold their OWN goal at once.
  const b = JSON.parse(stop(h, stopPayload({ session_id: 'B', cwd: '/tmp/proj' })).stdout);
  assert.equal(b.decision, 'block');
  assert.match(b.reason, /goal 'goal-y' not converged/);

  // counters are per (session, goal), each in its own FLAT slot — no interference
  const st = readState(h);
  assert.equal(st.sessions.A.goalId, 'goal_x');
  assert.equal(st.sessions.B.goalId, 'goal_y');
  assert.equal(st.sessions.A.continuations, 1);
  assert.equal(st.sessions.B.continuations, 1);
});

// ── ROTATION: one session, two owned goals, BOTH steered across successive stops ─────────
test('portfolio rotation: two owned goals are BOTH driven across successive stops (round-robin)', () => {
  const h = homes();
  twoGoalPortfolio(h);

  // stop 1 → steers goal_x (both never-steered; tie broken by goalId asc)
  const s1 = JSON.parse(stop(h, stopPayload({ session_id: 'A' })).stdout);
  assert.equal(s1.decision, 'block');
  assert.match(s1.reason, /goal 'goal-x' not converged/);
  assert.match(s1.reason, /\[belay portfolio\] this session owns 2 active goal\(s\); steering 'goal-x' this turn/);
  assert.match(s1.reason, /1 other unconverged sibling\(s\) will be steered on following stops/);

  // stop 2 → goal_x is now freshly-steered, so the OTHER goal is oldest → steers goal_y
  const s2 = JSON.parse(stop(h, stopPayload({ session_id: 'A' })).stdout);
  assert.equal(s2.decision, 'block');
  assert.match(s2.reason, /goal 'goal-y' not converged/);
  assert.match(s2.reason, /steering 'goal-y' this turn/);

  // stop 3 → goal_y just steered → back to goal_x
  const s3 = JSON.parse(stop(h, stopPayload({ session_id: 'A' })).stdout);
  assert.match(s3.reason, /steering 'goal-x' this turn/);

  // each goal has its OWN durable per-(session,goal) counter in the portfolios map; the flat
  // sessions slot is NOT used on the portfolio path.
  const st = readState(h);
  assert.equal(st.portfolios.A.goal_x.continuations, 2); // steered on stops 1 and 3
  assert.equal(st.portfolios.A.goal_y.continuations, 1); // steered on stop 2
  assert.equal(st.sessions?.A, undefined); // flat slot untouched by the portfolio path
});

// ── ALLOW only when ALL owned goals have nothing to hold ─────────────────────────────────
test('portfolio allows the stop only when EVERY owned goal is done; a single unmet goal still holds', () => {
  // mixed: goal_x unmet, goal_y clean → the portfolio STILL blocks (on goal_x)
  const mixed = homes();
  twoGoalPortfolio(mixed, { xObs: unmetObs('goal_x'), yObs: cleanObs('goal_y') });
  const m = JSON.parse(stop(mixed, stopPayload({ session_id: 'A' })).stdout);
  assert.equal(m.decision, 'block');
  assert.match(m.reason, /goal 'goal-x' not converged/);

  // both clean → nothing to hold → ALLOW (portfolio-idle), stdout empty
  const done = homes();
  twoGoalPortfolio(done, { xObs: cleanObs('goal_x'), yObs: cleanObs('goal_y') });
  const r = stop(done, stopPayload({ session_id: 'A' }));
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /portfolio: all 2 owned goal\(s\) this session are converged\/exhausted\/paused — allowing stop/);
});

// ── CROSS-SESSION non-interference: A arming a 2nd goal does NOT release B's goal ────────
test('arming a 2nd goal for session A leaves session B’s armed goal steering, untouched', () => {
  const h = homes();
  // A owns goal_x, B owns goal_y; both unmet and blocking.
  writeKeyoku(h, { goals: [gX(), gY(), gZ()], focus: focusFor({ goalId: 'goal_x', goalSlug: 'goal-x' }), obsLines: [unmetObs('goal_x')] });
  writeKeyoku(h, { obsLines: [unmetObs('goal_y')] });
  writeKeyoku(h, { obsLines: [unmetObs('goal_z')] });
  writeLoops(h, { goal_x: { session_id: 'A' }, goal_y: { session_id: 'B' } });
  writeTokenroom(h, { leftPct: 72 });

  // baseline: B blocks on goal_y, spends a continuation
  assert.match(JSON.parse(stop(h, stopPayload({ session_id: 'B' })).stdout).reason, /goal 'goal-y' not converged/);
  assert.equal(readState(h).sessions.B.continuations, 1);

  // A ADDS goal_z to its portfolio (now owns {x, z}). This writes ONLY A's loops entries.
  writeLoops(h, { goal_x: { session_id: 'A' }, goal_y: { session_id: 'B' }, goal_z: { session_id: 'A' } });

  // A now takes the portfolio path (2 owned active goals)…
  const a = JSON.parse(stop(h, stopPayload({ session_id: 'A' })).stdout);
  assert.equal(a.decision, 'block');
  assert.match(a.reason, /\[belay portfolio\] this session owns 2 active goal\(s\)/);

  // …and B STILL steers goal_y, its counter untouched by A's arming (no cross-session eviction).
  const b = JSON.parse(stop(h, stopPayload({ session_id: 'B' })).stdout);
  assert.equal(b.decision, 'block');
  assert.match(b.reason, /goal 'goal-y' not converged/);
  const st = readState(h);
  assert.equal(st.sessions.B.goalId, 'goal_y');
  assert.equal(st.sessions.B.continuations, 2); // 1 (baseline) + 1 (this block) — A never reset it
});

// ── TERMINATION (ADR-6 generalized): each owned goal independently capped; portfolio drains ─
test('portfolio termination: each owned goal is capped at max_continuations, then the whole set releases', () => {
  const h = homes();
  twoGoalPortfolio(h);
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'config.json'), JSON.stringify({ max_continuations: 2 }));

  // Drive many stops; the portfolio may block at most 2 (x) + 2 (y) = 4 times, then allows forever.
  let blocks = 0;
  for (let i = 0; i < 12; i++) if (JSON.parse(stop(h, stopPayload({ session_id: 'A' })).stdout || '{}').decision === 'block') blocks++;
  assert.equal(blocks, 4, `expected exactly 4 blocks (2 per owned goal), got ${blocks}`);

  // both per-goal counters sit at the cap; every further stop allows (monotonic release)
  const st = readState(h);
  assert.equal(st.portfolios.A.goal_x.continuations, 2);
  assert.equal(st.portfolios.A.goal_y.continuations, 2);
  assert.equal(stop(h, stopPayload({ session_id: 'A' })).stdout, '');
});

// ── BACKWARD-COMPAT: a session owning exactly ONE goal is byte-identical to pre-B3 ───────
test('backward-compat: one owned goal → single (flat) path, no portfolio wording, flat state.json slot', () => {
  const h = homes();
  // A owns exactly one active loop; focus.json agrees (the ordinary single-session single-goal world).
  writeKeyoku(h, { goals: [gX()], focus: focusFor({ goalId: 'goal_x', goalSlug: 'goal-x', sessionId: 'A' }), obsLines: [unmetObs('goal_x')] });
  writeLoops(h, { goal_x: { session_id: 'A' } });
  writeTokenroom(h, { leftPct: 72 });

  const r = JSON.parse(stop(h, stopPayload({ session_id: 'A' })).stdout);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /^\[belay ⟳ steering\] goal 'goal-x' not converged/);
  assert.doesNotMatch(r.reason, /\[belay portfolio\]/); // single goal → NO portfolio suffix

  const st = readState(h);
  assert.equal(st.sessions.A.continuations, 1); // uses the FLAT slot, exactly like pre-B3
  assert.equal(st.sessions.A.goalId, 'goal_x');
  assert.equal(st.portfolios, undefined); // the portfolios map is never created for a single-goal session
});

// ── ADR-33: project-scoping belt-and-suspenders on ownedActiveUnits ──────────────────────
// Alongside the existing (already-exact) session_id match, a unit whose loop entry carries a
// `project` that does NOT match this session's OWN derived project (from the Stop payload's
// cwd) is ALSO excluded from the owned set — a second, independent guard. A loop with no
// `project` field is never affected (legacy fallback).

test('ADR-33: a loop entry whose stored project does NOT match this session\'s cwd project is excluded from the owned portfolio', () => {
  const h = homes();
  // THREE goals owned by session A: goal_x/goal_y carry the SAME project as the stop
  // payload's cwd ('/tmp/proj'); goal_z carries an UNRELATED project. Belt-and-suspenders
  // excludes goal_z from the owned SET (still 2 remain → the portfolio path still engages
  // normally), and goal_z must never appear anywhere in the steered reason.
  writeKeyoku(h, { goals: [gX(), gY(), gZ()], focus: focusFor({ goalId: 'goal_x', goalSlug: 'goal-x' }), obsLines: [unmetObs('goal_x')] });
  writeKeyoku(h, { obsLines: [unmetObs('goal_y')] });
  writeKeyoku(h, { obsLines: [unmetObs('goal_z')] });
  writeLoops(h, {
    goal_x: { session_id: 'A', project: '/tmp/proj' },
    goal_y: { session_id: 'A', project: '/tmp/proj' },
    goal_z: { session_id: 'A', project: '/tmp/some-other-project' },
  });
  writeTokenroom(h, { leftPct: 72 });
  const r = JSON.parse(stop(h, stopPayload({ session_id: 'A', cwd: '/tmp/proj' })).stdout);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /\[belay portfolio\] this session owns 2 active goal\(s\)/, 'goal_z excluded — only 2 owned, portfolio path still engages');
  assert.doesNotMatch(r.reason, /goal-z/, 'the project-mismatched goal never appears in the steered reason');
});

test('ADR-33: matching (or absent) project fields never change portfolio behavior — belt-and-suspenders is a no-op in the normal case', () => {
  const h = homes();
  twoGoalPortfolio(h);
  // both loops carry the SAME project as the session's cwd — the normal, expected case.
  writeLoops(h, { goal_x: { session_id: 'A', project: '/tmp/proj' }, goal_y: { session_id: 'A', project: '/tmp/proj' } });
  const r = JSON.parse(stop(h, stopPayload({ session_id: 'A', cwd: '/tmp/proj' })).stdout);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /\[belay portfolio\] this session owns 2 active goal\(s\)/, 'both goals still owned — matching projects change nothing');
});

// ── never-crash: a corrupt loops.json degrades to the single path, never throws ──────────
test('never-crash: garbage loops.json falls back to the single focus path (still blocks, exit 0)', () => {
  const h = homes();
  writeKeyoku(h, { goals: [gX()], focus: focusFor({ goalId: 'goal_x', goalSlug: 'goal-x' }), obsLines: [unmetObs('goal_x')] });
  writeTokenroom(h, { leftPct: 72 });
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'loops.json'), 'not json at all');
  const r = stop(h, stopPayload({ session_id: 'A' }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, 'block'); // degrades to focus.json → single path
});
