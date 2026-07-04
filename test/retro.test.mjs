import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homes, run, goal, writeKeyoku, writeClaudeJson, nowSec } from './helpers.mjs';

// Learning flywheel (ADR-21): retro capture on disarm + `belay loop retro`.

const probeKeyokuBin = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'probe-keyoku.mjs');

function withEnv(h, fn) {
  const keys = { KEYOKU_HOME: h.keyoku, TOKENROOM_DIR: h.tokenroom, BELAY_DIR: h.belay, CLAUDE_CONFIG_DIR: h.config };
  const prev = {};
  for (const [k, v] of Object.entries(keys)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const retro = await import('../src/retro.mjs');

test('buildRetro composes convergence + thrash telemetry from goals.json + state.json; write/read round-trips', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal({ status: 'converged', usedIterations: 2 })] });
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'state.json'), JSON.stringify({ sessions: { s1: { goalId: 'goal_test1', continuations: 4, staleBlocked: true, sameUnmetCount: 5, updated_at: nowSec() } } }));
  const r = withEnv(h, () => retro.buildRetro('goal_test1'));
  assert.equal(r.outcome, 'converged');
  assert.equal(r.converged, true);
  assert.equal(r.continuations, 4);
  assert.equal(r.maxSameUnmet, 5);
  assert.equal(r.thrashed, true); // 5 >= thrash_threshold (3)
  assert.equal(r.stalled, false); // 5 < thrash_release (8)
  assert.equal(r.staleBlocked, true);

  withEnv(h, () => retro.writeRetro(r));
  const list = withEnv(h, () => retro.readRetros());
  assert.equal(list.at(-1).goalId, 'goal_test1');
  assert.equal(list.at(-1).slug, 'ship-widget');
});

test('belay loop retro <goal> writes a local retro AND files it into keyoku knowledge', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal({ status: 'converged', usedIterations: 2 })] });
  writeClaudeJson(h, { keyokuCmd: { type: 'stdio', command: process.execPath, args: [probeKeyokuBin], env: { KEYOKU_HOME: h.keyoku } } });
  const r = run(h, ['loop', 'retro', 'ship-widget']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.pushed, true, JSON.stringify(out));
  assert.ok(existsSync(join(h.belay, 'retros.jsonl')));
  const k = readFileSync(join(h.keyoku, 'knowledge.jsonl'), 'utf8');
  assert.match(k, /belay loop 'ship-widget' ended converged/);
  assert.match(k, /domain:belay-loop:ship-widget/);
});

test('belay loop retro <goal> --no-push writes local only (no keyoku spawn)', () => {
  const h = homes();
  writeKeyoku(h, { goals: [goal({ status: 'active' })] });
  const r = run(h, ['loop', 'retro', 'ship-widget', '--no-push']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.pushed, false);
  assert.ok(existsSync(join(h.belay, 'retros.jsonl')));
  assert.ok(!existsSync(join(h.keyoku, 'knowledge.jsonl')));
});

test('belay loop retro (no goal) lists recent retros', () => {
  const h = homes();
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'retros.jsonl'), JSON.stringify({ at: 'x', goalId: 'g1', slug: 'g-one', outcome: 'converged' }) + '\n');
  const out = JSON.parse(run(h, ['loop', 'retro']).stdout);
  assert.equal(out.retros.length, 1);
  assert.equal(out.retros[0].slug, 'g-one');
});
