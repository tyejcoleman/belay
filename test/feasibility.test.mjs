import test from 'node:test';
import assert from 'node:assert/strict';
import { findContradictions, loopCreate } from '../src/loops.mjs';

// Feasibility screen: a loop that can never converge is refused BEFORE any keyoku write —
// early, deterministic, and conservative (only contradictions true for EVERY output).

const probe = { kind: 'command', run: 'cat /tmp/x', parse: 'text' };
const crit = (assert_, p = probe) => ({ description: 'c', probe: p, assert: assert_ });

test('findContradictions flags mutually exclusive assertions on the same probe+path', () => {
  const pairs = [
    [{ op: 'eq', value: 'A' }, { op: 'eq', value: 'B' }],
    [{ op: 'eq', value: 'A' }, { op: 'ne', value: 'A' }],
    [{ op: 'contains', value: 'OK' }, { op: 'not_contains', value: 'OK' }],
    [{ op: 'exists' }, { op: 'not_exists' }],
    [{ op: 'truthy' }, { op: 'falsy' }],
    [{ op: 'gt', value: 5 }, { op: 'lt', value: 3 }],
    [{ op: 'gte', value: 5 }, { op: 'lt', value: 5 }],
  ];
  for (const [a, b] of pairs) {
    assert.equal(findContradictions([crit(a), crit(b)]).length, 1, `${a.op}/${b.op} must contradict`);
    assert.equal(findContradictions([crit(b), crit(a)]).length, 1, `${b.op}/${a.op} must contradict (order-independent)`);
  }
});

test('findContradictions stays conservative: satisfiable combinations pass', () => {
  const fine = [
    [{ op: 'contains', value: 'OK' }, { op: 'not_contains', value: 'ERROR' }], // different values
    [{ op: 'gt', value: 3 }, { op: 'lt', value: 5 }], // overlapping range
    [{ op: 'gte', value: 5 }, { op: 'lte', value: 5 }], // exactly 5 satisfies both
    [{ op: 'eq', value: 'A' }, { op: 'eq', value: 'A' }], // duplicates agree
  ];
  for (const [a, b] of fine) assert.equal(findContradictions([crit(a), crit(b)]).length, 0, `${a.op}/${b.op} is satisfiable`);
  // same assertions but DIFFERENT probes or paths — independent outputs, never flagged
  const otherProbe = { kind: 'command', run: 'cat /tmp/y', parse: 'text' };
  assert.equal(findContradictions([crit({ op: 'exists' }), crit({ op: 'not_exists' }, otherProbe)]).length, 0);
  assert.equal(findContradictions([crit({ op: 'exists', path: 'a' }), crit({ op: 'not_exists', path: 'b' })]).length, 0);
  // malformed input degrades to no findings, never a throw (ADR-4 posture)
  assert.equal(findContradictions(null).length, 0);
  assert.equal(findContradictions([{ probe }, { assert: { op: 'eq' } }, 42]).length, 0);
});

test('loopCreate refuses logically unsatisfiable criteria before any write', async () => {
  const r = await loopCreate({
    objective: 'impossible: done.txt both contains and does not contain OK',
    criteria: [crit({ op: 'contains', value: 'OK' }), crit({ op: 'not_contains', value: 'OK' })],
    session_id: 's1',
    cwd: '/tmp/proj',
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'feasibility');
  assert.match(r.error, /logically unsatisfiable/);
  assert.match(r.error, /Nothing was created or focused/);
  assert.deepEqual(r.steps, [], 'refused before resolve/create — no step completed');
});
