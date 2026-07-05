import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run } from './helpers.mjs';

// `belay selftest` — the hook-contract canary. Spawns the real hooks against a throwaway world
// and proves the enforcement path blocks/arrests on this install; reports live-harness liveness
// from the real journal.

test('selftest passes the enforcement checks on a healthy install', () => {
  const h = homes();
  const r = run(h, ['selftest']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[ok\] Stop hook BLOCKS/);
  assert.match(r.stdout, /\[ok\] PreToolUse gate HOLDS/);
  assert.match(r.stdout, /\[ok\] fall-arrest holds behind a shell wrapper/);
  assert.match(r.stdout, /\[ok\] benign command passes untouched/);
  assert.match(r.stdout, /PASS — belay blocks and arrests correctly/);
});

test('selftest reports live-harness liveness from the journal (and warns when absent)', () => {
  const h = homes();
  assert.match(run(h, ['selftest']).stdout, /no production decisions journaled yet/); // empty BELAY_DIR

  const h2 = homes();
  mkdirSync(h2.belay, { recursive: true });
  writeFileSync(join(h2.belay, 'decisions.jsonl'), JSON.stringify({ at: new Date().toISOString(), session_id: 'sX', action: 'allow', kind: 'no-focus' }) + '\n');
  assert.match(run(h2, ['selftest']).stdout, /hooks last fired 0m ago across 1 session/);
});
