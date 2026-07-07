import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeTokenroom, stopPayload, nowSec } from './helpers.mjs';

// ── B7 / ADR-24: facilitator-set "awaiting async work" marker ────────────────────────────
// When the facilitator dispatches a background sub-agent/Workflow and then stops, the harness
// auto-resumes the main agent on worker completion — so belay FORCING a continuation is a
// wasted spin. `belay await on` sets a SESSION-SCOPED marker the Stop hook honors by ALLOWING
// the stop (kind 'awaiting-async'); `belay await off` clears it. ALLOW-ONLY: it never forces a
// continuation, so ADR-6 termination is untouched. Proves: (a) marker set → an otherwise-
// BLOCKING unconverged autonomous goal now ALLOWS; (b) without it, byte-identical to today;
// (c) session-scoped — a marker for session A never releases session B's loop.

const stop = (h, payload) => run(h, ['hook', 'stop'], payload ?? stopPayload());
const { decideStop } = await import('../src/stop.mjs');
const { validateConfig } = await import('../src/util.mjs');

const kFixture = () => ({ present: true, paused: false, focus: focusFor(), matched: true, goal: goal(), obs: obs() });
const cfg = validateConfig(null).cfg;
const entry0 = { goalId: 'goal_test1', continuations: 0, staleBlocked: false, lastUnmetHash: null, sameUnmetCount: 0 };

/** Run fn with process.env.BELAY_DIR pinned to a world, restored after (for in-process await.mjs). */
async function withBelayDir(dir, fn) {
  const prev = process.env.BELAY_DIR;
  process.env.BELAY_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BELAY_DIR;
    else process.env.BELAY_DIR = prev;
  }
}

// ── (a) marker set → an otherwise-BLOCKING goal ALLOWS with kind 'awaiting-async' ──────────

test('(a) with the await marker set, an otherwise-BLOCKING unconverged autonomous goal ALLOWS the stop', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h, { leftPct: 72 });

  // baseline: this exact world BLOCKS (drives home that the marker is what flipped it)
  const before = stop(h);
  assert.equal(JSON.parse(before.stdout).decision, 'block');

  // facilitator dispatches background work: `belay await on` (also exercises the CLI verb)
  const set = run(h, ['await', 'on', '--session-id', 's1']);
  assert.equal(set.status, 0);
  assert.deepEqual(JSON.parse(set.stdout), { await: 'on', session_id: 's1' });
  // the marker file is owner-only, like the rest of belay's state
  assert.ok(existsSync(join(h.belay, 'await.json')));
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(h.belay, 'await.json')).mode & 0o777, 0o600);
    assert.equal(statSync(h.belay).mode & 0o777, 0o700);
  }

  // the baseline block above bumped the counter to 1; record it so we can prove the awaiting
  // allow leaves it untouched (an allow is not a block path — ADR-6 counters are not consumed)
  const cBefore = JSON.parse(readFileSync(join(h.belay, 'state.json'), 'utf8')).sessions.s1.continuations;

  // now the SAME unconverged goal ALLOWS the stop — nothing on stdout, the awaiting note on stderr
  const r = stop(h);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'awaiting async work → allow (no block JSON)');
  assert.match(r.stderr, /facilitator awaiting async work/);

  // the allow did NOT consume a continuation — it is not a block path (ADR-6 counters untouched)
  const cAfter = JSON.parse(readFileSync(join(h.belay, 'state.json'), 'utf8')).sessions.s1.continuations;
  assert.equal(cAfter, cBefore, 'awaiting-async does not increment the continuation counter');

  // and the decision journal records the exact kind
  const journal = readFileSync(join(h.belay, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = journal[journal.length - 1];
  assert.equal(last.action, 'allow');
  assert.equal(last.kind, 'awaiting-async');

  // `belay await off` clears it → the goal is BLOCKING again (loop re-engages)
  const off = run(h, ['await', 'off', '--session-id', 's1']);
  assert.equal(off.status, 0);
  assert.deepEqual(JSON.parse(off.stdout), { await: 'off', session_id: 's1', was_set: true });
  assert.equal(JSON.parse(stop(h).stdout).decision, 'block', 'cleared marker → steering resumes');
});

// ── (b) WITHOUT the marker, decideStop output is byte-identical to today ───────────────────

test('(b) without the marker, decideStop is byte-identical — the awaiting param defaults false and the branch is inert', () => {
  // the default (5-arg) call MUST equal an explicit awaiting=false call: proves the new param
  // defaults false and nothing on the no-marker path changed.
  const dDefault = decideStop(stopPayload(), kFixture(), { known: false }, cfg, entry0, nowSec(), {});
  const dFalse = decideStop(stopPayload(), kFixture(), { known: false }, cfg, entry0, nowSec(), {}, false);
  assert.deepEqual(dDefault, dFalse);
  // and it is still the SAME block decision it has always produced for this fixture
  assert.equal(dDefault.action, 'block');
  assert.equal(dDefault.kind, 'block');

  // awaiting=true flips exactly that block into the awaiting-async allow, with NO counter save
  const dTrue = decideStop(stopPayload(), kFixture(), { known: false }, cfg, entry0, nowSec(), {}, true);
  assert.equal(dTrue.action, 'allow');
  assert.equal(dTrue.kind, 'awaiting-async');
  assert.equal(dTrue.save, undefined, 'unconditional allow — no state mutation (ADR-6 untouched)');

  // e2e: a real hook with no marker present blocks exactly as the baseline suite asserts
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h, { leftPct: 72 });
  const out = JSON.parse(stop(h).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^\[belay ⟳ steering\] goal 'ship-widget' not converged/);
});

// ── (c) session-scoped — a marker for session A never releases session B's loop ────────────

test('(c) the marker is SESSION-SCOPED: set for session A, session B (same cwd-scoped goal) still BLOCKS', () => {
  const h = homes();
  // focus is cwd-scoped (no sessionId pin), so BOTH sessions at cwd /tmp/proj are held by the goal.
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h, { leftPct: 72 });

  // await set for session A only
  const set = run(h, ['await', 'on', '--session-id', 'sessionA']);
  assert.equal(set.status, 0);

  // session A stops → ALLOWED (awaiting-async)
  const a = stop(h, stopPayload({ session_id: 'sessionA' }));
  assert.equal(a.stdout, '', 'session A is awaiting → allow');
  assert.match(a.stderr, /facilitator awaiting async work/);

  // session B stops on the SAME goal/world → still BLOCKS (its marker is not set)
  const b = stop(h, stopPayload({ session_id: 'sessionB' }));
  assert.equal(JSON.parse(b.stdout).decision, 'block', 'session B must NOT be released by session A\'s marker');
  assert.match(JSON.parse(b.stdout).reason, /not converged/);
});

// ── unit coverage of the marker module + CLI edges ─────────────────────────────────────────

test('await.mjs: setAwait/isAwaiting/clearAwait roundtrip is per-session; garbage & empty ids degrade to false', async () => {
  const h = homes();
  await withBelayDir(h.belay, async () => {
    const { setAwait, clearAwait, isAwaiting } = await import('../src/await.mjs');
    assert.equal(isAwaiting('s1'), false); // no file yet
    setAwait('s1');
    assert.equal(isAwaiting('s1'), true);
    assert.equal(isAwaiting('s2'), false); // scoped: s2 unaffected
    assert.equal(isAwaiting(''), false); // empty id never awaiting
    assert.equal(isAwaiting(null), false);
    // clear is scoped and reports prior presence
    assert.equal(clearAwait('s2'), false);
    assert.equal(clearAwait('s1'), true);
    assert.equal(isAwaiting('s1'), false);
  });
});

test('await.mjs: a stale (>7d) marker self-prunes on the next write (state.mjs discipline); garbage/corrupt files degrade to not-awaiting', async () => {
  const h = homes();
  await withBelayDir(h.belay, async () => {
    const { setAwait, isAwaiting } = await import('../src/await.mjs');
    const { atomicWriteJSON, atomicWrite, ensureDir } = await import('../src/util.mjs');
    ensureDir(h.belay);
    // hand-write an 8-day-old marker for 'old', a live one for 'keep', and a garbage-shaped entry
    atomicWriteJSON(join(h.belay, 'await.json'), { sessions: { old: { at: nowSec() - 8 * 86400 }, keep: { at: nowSec() - 60 }, junk: 'not-an-object' } });
    assert.equal(isAwaiting('keep'), true, 'a live marker is honored');
    assert.equal(isAwaiting('junk'), false, 'a garbage-shaped entry is never awaiting');
    // pruning is WRITE-time (like state.mjs), so any write drops the expired 'old' entry from the file
    setAwait('fresh');
    const st = JSON.parse(readFileSync(join(h.belay, 'await.json'), 'utf8'));
    assert.ok(!('old' in st.sessions), 'expired entry pruned on the next write');
    assert.ok('keep' in st.sessions && 'fresh' in st.sessions, 'live entries survive the prune');
    assert.ok(!('junk' in st.sessions), 'garbage entry pruned on the next write');

    // a wholly corrupt (non-JSON) file never throws and reads as not-awaiting (ADR-4 never-crash)
    atomicWrite(join(h.belay, 'await.json'), 'not json at all');
    assert.equal(isAwaiting('fresh'), false);
  });
});

test('belay await CLI: missing session id → exit 2; unknown subcommand → exit 2; bare form reports state', () => {
  const h = homes();
  // no --session-id and no $CLAUDE_CODE_SESSION_ID in the child env
  const noId = run(h, ['await', 'on']);
  assert.equal(noId.status, 2);
  assert.match(noId.stderr, /no session id/);

  const bogus = run(h, ['await', 'sideways', '--session-id', 's1']);
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /belay await <on\|off>/);

  // bare `belay await --session-id s1` reports current state (off before any set)
  const q1 = run(h, ['await', '--session-id', 's1']);
  assert.equal(q1.status, 0);
  assert.deepEqual(JSON.parse(q1.stdout), { await: 'off', session_id: 's1' });
  run(h, ['await', 'on', '--session-id', 's1']);
  const q2 = run(h, ['await', '--session-id', 's1']);
  assert.deepEqual(JSON.parse(q2.stdout), { await: 'on', session_id: 's1' });
});
