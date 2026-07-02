import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeTokenroom, stopPayload } from './helpers.mjs';

// TEST-A observability: every evaluated Stop lands one line in ~/.belay/decisions.jsonl —
// a stop that should have blocked but silently allowed is diagnosable after the fact.

const journal = (h) =>
  readFileSync(join(h.belay, 'decisions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test('stop decisions journal: a block and an out-of-scope allow both leave a line', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h);
  assert.equal(run(h, ['hook', 'stop'], stopPayload()).status, 0);
  let lines = journal(h);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].action, 'block');
  assert.equal(lines[0].kind, 'block');
  assert.equal(lines[0].session_id, 's1');
  assert.equal(lines[0].goal, 'goal_test1');

  assert.equal(run(h, ['hook', 'stop'], stopPayload({ session_id: 'stranger-session', cwd: '/somewhere/else' })).status, 0);
  lines = journal(h);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].action, 'allow');
  assert.equal(lines[1].kind, 'scope-mismatch');
  assert.equal(lines[1].session_id, 'stranger'); // capped to 8 chars — an id, not a fingerprint
});

test('status warns when an active autonomous focus has no sessionId pin', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  writeTokenroom(h);
  const r = run(h, ['status']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no sessionId pin/);

  const h2 = homes();
  writeKeyoku(h2, { goals: [goal()], focus: focusFor({ sessionId: 'sess-1' }), obsLines: [obs()] });
  writeTokenroom(h2);
  assert.doesNotMatch(run(h2, ['status']).stdout, /no sessionId pin/);
});
