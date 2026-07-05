import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, nowSec } from './helpers.mjs';

// `belay insights` — bucketing of the real decisions journal + retros + pending into a read.

function seed(h, { decisions = [], pending = [], retros = [] }) {
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'decisions.jsonl'), decisions.map((d) => JSON.stringify({ at: new Date().toISOString(), ...d })).join('\n') + '\n');
  if (pending.length) writeFileSync(join(h.belay, 'pending.json'), JSON.stringify({ pending }));
  if (retros.length) writeFileSync(join(h.belay, 'retros.jsonl'), retros.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('insights buckets decisions by meaning and tallies the fall-arrest, retros, pending', () => {
  const h = homes();
  seed(h, {
    decisions: [
      { action: 'allow', kind: 'no-focus', session_id: 's1' },
      { action: 'allow', kind: 'scope-mismatch', session_id: 's2' },
      { action: 'block', kind: 'block', session_id: 's1', goal: 'g1' },
      { action: 'block', kind: 'block-thrash', session_id: 's1', goal: 'g1' },
      { action: 'ask', kind: 'git push', session_id: 's1', goal: 'g1' },
      { action: 'deny', kind: 'rm -rf outside cwd', session_id: 's1', goal: 'g1' },
      { action: 'allow', kind: 'converged', session_id: 's1', goal: 'g1' },
    ],
    pending: [{ id: 'p1', ts: nowSec(), class: 'rm -rf outside cwd', tool_name: 'Bash', command: 'rm -rf /x', goalId: 'g1', sessionId: 's1' }],
    retros: [
      { at: 'x', goalId: 'g1', slug: 'a', outcome: 'converged', continuations: 2, thrashed: false },
      { at: 'y', goalId: 'g2', slug: 'b', outcome: 'blocked', continuations: 8, thrashed: true },
    ],
  });
  const ins = JSON.parse(run(h, ['insights', '--json']).stdout);

  assert.equal(ins.decisions.total, 7);
  assert.equal(ins.decisions.distinct_sessions, 2);
  assert.equal(ins.behavior.idle, 2); // no-focus + scope-mismatch
  assert.equal(ins.behavior.held, 2); // block + block-thrash
  assert.equal(ins.behavior.gated, 2); // ask + deny
  assert.equal(ins.behavior.released, 1); // converged
  assert.equal(ins.behavior.no_op_pct, Math.round((2 / 7) * 100));

  assert.equal(ins.fall_arrest.total_acts, 2);
  assert.deepEqual(ins.fall_arrest.by_class, { 'git push': 1, 'rm -rf outside cwd': 1 });

  assert.equal(ins.pending.count, 1);
  assert.equal(ins.retros.count, 2);
  assert.deepEqual(ins.retros.outcomes, { converged: 1, blocked: 1 });
  assert.equal(ins.retros.thrashed, 1);
  assert.equal(ins.retros.avg_continuations, 5); // (2 + 8) / 2
});

test('insights on an empty world says so without crashing', () => {
  const h = homes();
  const r = run(h, ['insights']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no decisions journaled yet/);
});
