import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeLoops, nowSec, iso } from './helpers.mjs';

// `belay mutations` (docs/DECISIONS.md ADR-32): "ALWAYS CHECK FOR MUTATIONS" — belay
// persists a small snapshot of THIS session's OWNED keyoku goal states and, on every
// subsequent check, diffs the live state against it. Detection/reporting only: read-only
// on keyoku, writes only belay's own goal-snap-<session>.json, and never feeds any
// gate/stop decision. Every case below asserts exit code 0 alongside stdout content.

const mutations = (h, args = []) => run(h, ['mutations', ...args]);
const snapFile = (h, sid) => JSON.parse(readFileSync(join(h.belay, `goal-snap-${sid}.json`), 'utf8'));

const { criteriaFingerprint, currentOwnedGoals, diffGoalSnapshots, mutationCount, computeMutations, renderMutations } = await import('../src/mutations.mjs');

// ── pure helpers ─────────────────────────────────────────────────────────────────────────

test('criteriaFingerprint: order-independent count+hash; non-array degrades to {count:0,hash:null}', () => {
  const a = criteriaFingerprint([{ id: 'c1', description: 'x' }, { id: 'c2', description: 'y' }]);
  const b = criteriaFingerprint([{ id: 'c2', description: 'y' }, { id: 'c1', description: 'x' }]); // reordered
  assert.deepEqual(a, b);
  assert.equal(a.count, 2);
  assert.equal(typeof a.hash, 'string');
  assert.deepEqual(criteriaFingerprint(null), { count: 0, hash: null });
  assert.deepEqual(criteriaFingerprint(undefined), { count: 0, hash: null });
  const c = criteriaFingerprint([{ id: 'c1', description: 'x' }]);
  assert.notEqual(c.hash, a.hash); // a genuinely different set hashes differently
});

test('currentOwnedGoals: only session_id-pinned loops.json entries; a goal missing from goals.json → status "missing"; never throws', () => {
  const rows = [{ id: 'g1', slug: 'ship-widget', status: 'active', criteria: [{ id: 'c1', description: 'x' }] }];
  const loopsMap = { g1: { session_id: 's1' }, g2: { session_id: 'other' }, g3: { session_id: 's1' } }; // g3 has no goals.json row
  const out = currentOwnedGoals('s1', loopsMap, rows);
  assert.deepEqual(Object.keys(out).sort(), ['g1', 'g3']); // g2 excluded (different session)
  assert.equal(out.g1.status, 'active');
  assert.equal(out.g1.slug, 'ship-widget');
  assert.equal(out.g3.status, 'missing');
  assert.deepEqual(currentOwnedGoals(null, loopsMap, rows), {});
  assert.deepEqual(currentOwnedGoals('s1', null, rows), {});
});

test('diffGoalSnapshots: converged/abandoned/status-flip/criteria-change/new/removed — every case, plus none', () => {
  const prev = {
    g1: { slug: 'a', status: 'active', criteria: { count: 2, hash: 'h1' } },
    g2: { slug: 'b', status: 'active', criteria: { count: 1, hash: 'h2' } },
    g3: { slug: 'c', status: 'active', criteria: { count: 1, hash: 'h3' } },
    g5: { slug: 'e', status: 'active', criteria: { count: 1, hash: 'h5' } }, // will be removed
  };
  const curr = {
    g1: { slug: 'a', status: 'converged', criteria: { count: 2, hash: 'h1' } }, // newly converged
    g2: { slug: 'b', status: 'abandoned', criteria: { count: 1, hash: 'h2' } }, // newly abandoned
    g3: { slug: 'c', status: 'blocked', criteria: { count: 1, hash: 'h3' } }, // plain status flip
    g4: { slug: 'd', status: 'active', criteria: { count: 1, hash: 'h4' } }, // new owned goal
    g6: { slug: 'f', status: 'active', criteria: { count: 3, hash: 'h6-new' } }, // treated as new (not in prev)
  };
  const d = diffGoalSnapshots(prev, curr);
  assert.deepEqual(d.newlyConverged, [{ goalId: 'g1', slug: 'a' }]);
  assert.deepEqual(d.newlyAbandoned, [{ goalId: 'g2', slug: 'b' }]);
  assert.deepEqual(
    d.statusFlips.sort((x, y) => x.goalId.localeCompare(y.goalId)),
    [
      { goalId: 'g1', slug: 'a', from: 'active', to: 'converged' },
      { goalId: 'g2', slug: 'b', from: 'active', to: 'abandoned' },
      { goalId: 'g3', slug: 'c', from: 'active', to: 'blocked' },
    ]
  );
  assert.deepEqual(d.newOwnedGoals.map((r) => r.goalId).sort(), ['g4', 'g6']);
  assert.deepEqual(d.removedOwnedGoals, [{ goalId: 'g5', slug: 'e', lastStatus: 'active' }]);
  assert.equal(d.criteriaChanges.length, 0); // g1's criteria fingerprint is unchanged

  // criteria-change case in isolation
  const dc = diffGoalSnapshots({ g1: { slug: 'a', status: 'active', criteria: { count: 2, hash: 'h1' } } }, { g1: { slug: 'a', status: 'active', criteria: { count: 3, hash: 'h1-new' } } });
  assert.equal(dc.criteriaChanges.length, 1);
  assert.equal(dc.criteriaChanges[0].delta, 1);
  assert.equal(dc.statusFlips.length, 0);

  // none case
  const dn = diffGoalSnapshots({ g1: { slug: 'a', status: 'active', criteria: { count: 1, hash: 'h1' } } }, { g1: { slug: 'a', status: 'active', criteria: { count: 1, hash: 'h1' } } });
  assert.equal(mutationCount(dn), 0);
});

test('diffGoalSnapshots / mutationCount: never throw on malformed input', () => {
  assert.doesNotThrow(() => diffGoalSnapshots(null, undefined));
  assert.doesNotThrow(() => diffGoalSnapshots('garbage', 42));
  assert.equal(mutationCount(null), 0);
  assert.equal(mutationCount(undefined), 0);
  assert.equal(mutationCount('garbage'), 0);
});

// ── computeMutations / CLI end-to-end (real bin, hermetic worlds) ─────────────────────────

test('computeMutations: first-ever check establishes the baseline — hasPrior:false, EMPTY diff (not "everything is new")', () => {
  const h = homes();
  const prevDir = process.env.BELAY_DIR;
  const prevHome = process.env.KEYOKU_HOME;
  process.env.BELAY_DIR = h.belay;
  process.env.KEYOKU_HOME = h.keyoku;
  try {
    writeKeyoku(h, { goals: [goal()] });
    writeLoops(h, { goal_test1: { session_id: 's1' } });
    const m = computeMutations('s1');
    assert.equal(m.hasPrior, false);
    assert.equal(mutationCount(m), 0);
    assert.deepEqual(m.newOwnedGoals, []); // NOT reported as "new" on the very first check
    const snap = snapFile(h, 's1');
    assert.ok(snap.goals.goal_test1); // baseline WAS captured to disk
  } finally {
    if (prevDir === undefined) delete process.env.BELAY_DIR;
    else process.env.BELAY_DIR = prevDir;
    if (prevHome === undefined) delete process.env.KEYOKU_HOME;
    else process.env.KEYOKU_HOME = prevHome;
  }
});

test('belay mutations (CLI): converged status flip is detected on the SECOND check', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, { goal_test1: { session_id: 's1' } });

  const first = mutations(h, ['--session-id', 's1', '--json']);
  assert.equal(first.status, 0);
  const m1 = JSON.parse(first.stdout);
  assert.equal(m1.hasPrior, false);

  writeKeyoku(h, { goals: [goal({ status: 'converged', convergedAt: iso(nowSec()) })] });
  const second = mutations(h, ['--session-id', 's1', '--json']);
  assert.equal(second.status, 0);
  const m2 = JSON.parse(second.stdout);
  assert.equal(m2.hasPrior, true);
  assert.deepEqual(m2.newlyConverged, [{ goalId: 'goal_test1', slug: 'ship-widget' }]);
  assert.equal(m2.statusFlips.length, 1);
  assert.equal(m2.statusFlips[0].from, 'active');
  assert.equal(m2.statusFlips[0].to, 'converged');

  const text = mutations(h, ['--session-id', 's1']).stdout; // third check: no further change
  assert.match(text, /no changes since last check/);
});

test('belay mutations (CLI): abandoned status flip is detected', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  mutations(h, ['--session-id', 's1']); // baseline
  writeKeyoku(h, { goals: [goal({ status: 'abandoned' })] });
  const r = mutations(h, ['--session-id', 's1', '--json']);
  assert.equal(r.status, 0);
  const m = JSON.parse(r.stdout);
  assert.deepEqual(m.newlyAbandoned, [{ goalId: 'goal_test1', slug: 'ship-widget' }]);
});

test('belay mutations (CLI): criteria added is detected with the correct delta', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] }); // 2 criteria (c1, c2)
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  mutations(h, ['--session-id', 's1']); // baseline
  writeKeyoku(h, { goals: [goal({ criteria: [{ id: 'c1', description: 'tests green' }, { id: 'c2', description: 'deployed to prod' }, { id: 'c3', description: 'docs updated' }] })] });
  const r = mutations(h, ['--session-id', 's1', '--json']);
  const m = JSON.parse(r.stdout);
  assert.equal(m.criteriaChanges.length, 1);
  assert.equal(m.criteriaChanges[0].delta, 1);
  assert.equal(m.criteriaChanges[0].to.count, 3);
});

test('belay mutations (CLI): new owned goal + removed owned goal (loop entry disappears — disarmed/pruned)', () => {
  const h = homes();
  const gY = goal({ id: 'goal_y', slug: 'ship-gadget' });
  writeKeyoku(h, { goals: [goal(), gY] });
  writeLoops(h, { goal_test1: { session_id: 's1' }, goal_y: { session_id: 's1' } });
  mutations(h, ['--session-id', 's1']); // baseline: owns both

  // goal_test1's loops.json entry disappears (disarm/prune); a brand new goal is armed
  const gZ = goal({ id: 'goal_z', slug: 'ship-thing' });
  writeKeyoku(h, { goals: [goal(), gY, gZ] });
  writeLoops(h, { goal_y: { session_id: 's1' }, goal_z: { session_id: 's1' } });

  const r = mutations(h, ['--session-id', 's1', '--json']);
  const m = JSON.parse(r.stdout);
  assert.deepEqual(m.removedOwnedGoals, [{ goalId: 'goal_test1', slug: 'ship-widget', lastStatus: 'active' }]);
  assert.deepEqual(m.newOwnedGoals, [{ goalId: 'goal_z', slug: 'ship-thing', status: 'active' }]);
});

// ── never-crash (ADR-4) ────────────────────────────────────────────────────────────────

test('belay mutations: no session id (neither --session-id nor $CLAUDE_CODE_SESSION_ID) → empty report, exit 0', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  const r = mutations(h, []);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no session id/);
  assert.equal(r.stderr, '');
});

test('belay mutations: keyoku home entirely absent → empty diff, exit 0', () => {
  const h = homes();
  writeLoops(h, { goal_test1: { session_id: 's1' } }); // loops.json exists; ~/.keyoku does not
  const r = mutations(h, ['--session-id', 's1', '--json']);
  assert.equal(r.status, 0);
  const m = JSON.parse(r.stdout);
  assert.equal(m.hasPrior, false);
  assert.equal(mutationCount(m), 0);
});

test('belay mutations: corrupted loops.json degrades to no owned goals, never crashes', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, '{ this is not valid json');
  const r = mutations(h, ['--session-id', 's1', '--json']);
  assert.equal(r.status, 0);
  const m = JSON.parse(r.stdout);
  assert.equal(mutationCount(m), 0);
});

test('belay mutations: corrupted PRIOR snapshot file is treated as absent (fresh baseline), never crashes', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()] });
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  mutations(h, ['--session-id', 's1']); // establishes a real snapshot
  writeFileSync(join(h.belay, 'goal-snap-s1.json'), '{ not valid json');
  const r = mutations(h, ['--session-id', 's1', '--json']);
  assert.equal(r.status, 0);
  const m = JSON.parse(r.stdout);
  assert.equal(m.hasPrior, false); // corrupted → treated as no prior
  assert.equal(existsSync(join(h.belay, 'goal-snap-s1.json')), true); // repaired on this read
});

test('renderMutations: human-readable form covers every section label; never throws on malformed input', () => {
  assert.doesNotThrow(() => renderMutations(null));
  assert.doesNotThrow(() => renderMutations(undefined));
  const text = renderMutations({
    sessionId: 's1',
    hasPrior: true,
    newlyConverged: [{ goalId: 'g1', slug: 'a' }],
    newlyAbandoned: [{ goalId: 'g2', slug: 'b' }],
    statusFlips: [{ goalId: 'g3', slug: 'c', from: 'active', to: 'blocked' }],
    criteriaChanges: [{ goalId: 'g4', slug: 'd', from: { count: 1 }, to: { count: 2 }, delta: 1 }],
    newOwnedGoals: [{ goalId: 'g5', slug: 'e', status: 'active' }],
    removedOwnedGoals: [{ goalId: 'g6', slug: 'f', lastStatus: 'active' }],
  });
  for (const needle of ['newly converged', 'newly abandoned', 'status flips', 'criteria changed', 'new owned goals', 'removed owned goals']) {
    assert.match(text, new RegExp(needle));
  }
});

// ── `belay status` integration: the one-line summary (ADR-32) ───────────────────────────

test('belay status: folds a "mutations: N changed" one-liner when a real sessionId is known (via the focus pin)', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor({ sessionId: 's1' }), obsLines: [obs()] });
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  const first = run(h, ['status']);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /mutations: 0 changed since last check\n/); // baseline check, nothing to report yet

  writeKeyoku(h, { goals: [goal({ status: 'converged', convergedAt: iso(nowSec()) })], focus: focusFor({ sessionId: 's1' }) });
  const second = run(h, ['status']);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /mutations: 1 changed since last check — run `belay mutations` for detail/);
});

test('belay status: no sessionId pin on focus and no $CLAUDE_CODE_SESSION_ID → no mutations line at all (no fabrication)', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] }); // focusFor() has no sessionId
  writeLoops(h, { goal_test1: { session_id: 's1' } });
  const r = run(h, ['status']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /mutations:/);
});
