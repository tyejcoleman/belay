import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, toolPayload, stopPayload, nowSec } from './helpers.mjs';

// gate_mode 'defer' queue (ADR-16): ~/.belay/pending.json mechanics + the surfacing
// paths (`belay pending`, `belay status`, the converged-stop stderr note). The queue is
// presentation metadata ONLY — no gate or stop decision reads it (ADR-12 mirror).

const gate = (h, payload) => run(h, ['hook', 'pre-tool-use'], payload);

function deferred() {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'config.json'), JSON.stringify({ gate_mode: 'defer' }));
  return h;
}

const readQueue = (h) => JSON.parse(readFileSync(join(h.belay, 'pending.json'), 'utf8'));

test('queue dedupe: the same deferred action queues once, a different one adds a second entry', () => {
  const h = deferred();
  gate(h, toolPayload({ tool_input: { command: 'git push origin main' } }));
  gate(h, toolPayload({ tool_input: { command: 'git push origin main' } })); // loop retry — same content id
  assert.equal(readQueue(h).pending.length, 1);
  gate(h, toolPayload({ tool_input: { command: 'npm publish' } }));
  const q = readQueue(h);
  assert.equal(q.pending.length, 2);
  assert.notEqual(q.pending[0].id, q.pending[1].id);
});

test('pending.json is written 0600 (owner-only, like every belay state file)', () => {
  const h = deferred();
  gate(h, toolPayload({ tool_input: { command: 'git push origin main' } }));
  assert.equal(statSync(join(h.belay, 'pending.json')).mode & 0o777, 0o600);
});

test('queued command is capped at 500 chars', () => {
  const h = deferred();
  const long = 'git push origin main ' + 'x'.repeat(600);
  gate(h, toolPayload({ tool_input: { command: long } }));
  const q = readQueue(h);
  assert.equal(q.pending.length, 1);
  assert.equal(q.pending[0].command.length, 500);
  assert.equal(q.pending[0].command, long.slice(0, 500));
});

test('belay pending lists entries human-readably; --remove drops one; --clear empties', () => {
  const h = deferred();
  gate(h, toolPayload({ tool_input: { command: 'git push origin main' } }));
  gate(h, toolPayload({ tool_input: { command: 'npm publish' } }));

  const list = run(h, ['pending']);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /2 deferred actions awaiting approval/);
  assert.match(list.stdout, /'git push'/);
  assert.match(list.stdout, /'npm publish'/);
  assert.match(list.stdout, /git push origin main/);

  const id = readQueue(h).pending[0].id;
  const rm = run(h, ['pending', '--remove', id]);
  assert.equal(rm.status, 0);
  assert.match(rm.stdout, new RegExp(`removed ${id}`));
  assert.equal(readQueue(h).pending.length, 1);

  // unknown id → exit 2, nothing dropped
  const miss = run(h, ['pending', '--remove', 'nope']);
  assert.equal(miss.status, 2);
  assert.equal(readQueue(h).pending.length, 1);

  const clear = run(h, ['pending', '--clear']);
  assert.equal(clear.status, 0);
  assert.match(clear.stdout, /cleared 1 deferred entry/);
  assert.equal(readQueue(h).pending.length, 0);
  assert.match(run(h, ['pending']).stdout, /0 deferred actions/);
});

test('belay status surfaces pending { count, classes }; 0 when the file is absent', () => {
  const h = deferred();
  gate(h, toolPayload({ tool_input: { command: 'git push origin main' } }));
  gate(h, toolPayload({ tool_input: { command: 'npm publish' } }));
  const r = run(h, ['status']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /pending: 2 deferred \[git push, npm publish\] — run `belay pending` to review/);

  const empty = homes();
  writeKeyoku(empty, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  assert.match(run(empty, ['status']).stdout, /pending: 0 deferred/);
});

test('converged stop with pending entries → allow + stderr reminder; empty queue → no reminder', () => {
  const h = homes();
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(
    join(h.belay, 'pending.json'),
    JSON.stringify({ pending: [{ id: 'abc123def456', ts: nowSec(), class: 'git push', tool_name: 'Bash', command: 'git push origin main', goalId: 'goal_test1', sessionId: 's1' }] })
  );
  writeKeyoku(h, { goals: [goal({ status: 'converged' })], focus: focusFor(), obsLines: [obs({ unmet: [] })] });
  const r = run(h, ['hook', 'stop'], stopPayload());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, ''); // the stop is ALLOWED — the queue never blocks it (ADR-12 mirror)
  assert.match(r.stderr, /converged — nothing to hold/);
  assert.match(r.stderr, /1 deferred action\(s\) await approval — run 'belay pending'/);

  const quiet = homes();
  writeKeyoku(quiet, { goals: [goal({ status: 'converged' })], focus: focusFor(), obsLines: [obs({ unmet: [] })] });
  const r2 = run(quiet, ['hook', 'stop'], stopPayload());
  assert.match(r2.stderr, /converged — nothing to hold/);
  assert.doesNotMatch(r2.stderr, /deferred action/);
});

test('the queue is never consulted by a decision: pending entries change no gate/stop verdict', () => {
  // Unconverged goal + pending entries: the stop still BLOCKS exactly as without them.
  const h = deferred();
  gate(h, toolPayload({ tool_input: { command: 'git push origin main' } }));
  const r = run(h, ['hook', 'stop'], stopPayload());
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).reason, /not converged/);
  // And a malformed pending.json degrades silently — the deny still lands (ADR-4).
  const broken = deferred();
  writeFileSync(join(broken.belay, 'pending.json'), '][');
  const d = gate(broken, toolPayload({ tool_input: { command: 'git push origin main' } }));
  assert.equal(d.status, 0);
  assert.equal(JSON.parse(d.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(existsSync(join(broken.belay, 'pending.json')), true);
});
