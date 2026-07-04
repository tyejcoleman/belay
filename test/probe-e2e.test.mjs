import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homes, run, mcpSession, jsonRpcSession, writeClaudeJson } from './helpers.mjs';

// Probe-driven e2e (closes the test-review realism gap): unlike the other e2e suites, which
// simulate convergence by hand-appending an observation line, this drives the WHOLE loop with a
// keyoku double that ACTUALLY RUNS the criterion's command probe — so the stop flips from block
// to allow because a real exit code changed, not because a test wrote a line.

const probeKeyokuBin = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'probe-keyoku.mjs');
const txt = (m) => JSON.parse(m.result.content[0].text);

test('a REAL failing probe blocks the stop; making it pass converges and releases the hold', async () => {
  const h = homes();
  const donePath = join(h.base, 'done.txt');
  writeClaudeJson(h, { keyokuCmd: { type: 'stdio', command: process.execPath, args: [probeKeyokuBin], env: { KEYOKU_HOME: h.keyoku } } });

  // 1. create + arm a loop with a REAL command probe, pinned to this session
  const belay = mcpSession(h);
  await belay.call('initialize', { protocolVersion: '2025-06-18' });
  belay.notify('notifications/initialized', {});
  const created = txt(
    await belay.call('tools/call', {
      name: 'belay_loop_create',
      arguments: {
        objective: 'done file says OK',
        criteria: [{ id: 'c1', description: 'done.txt contains OK', probe: { kind: 'command', command: `cat ${donePath}` }, assert: { op: 'contains', value: 'OK' } }],
        session_id: 's1',
        cwd: h.base,
      },
    })
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  const slug = created.goal.slug;
  await belay.close();

  // assess through probe-keyoku (runs the real probe against the current filesystem)
  const assess = async () => {
    const k = jsonRpcSession(process.execPath, [probeKeyokuBin], { KEYOKU_HOME: h.keyoku });
    await k.call('initialize', { protocolVersion: '2025-06-18' });
    const r = txt(await k.call('tools/call', { name: 'goal_assess', arguments: { goal: slug } }));
    await k.close();
    return r;
  };

  // 2. probe FAILS (no done.txt yet) → unmet c1
  const a1 = await assess();
  assert.deepEqual(a1.unmet, ['c1']);
  assert.equal(a1.converged, false);

  // 3. belay stop → BLOCK on the real unmet criterion
  const blocked = run(h, ['hook', 'stop'], { session_id: 's1', cwd: h.base });
  assert.equal(blocked.status, 0);
  const bo = JSON.parse(blocked.stdout);
  assert.equal(bo.decision, 'block');
  assert.match(bo.reason, /not converged .* c1: done\.txt contains OK/);

  // 4. do the work: make the probe pass for real
  writeFileSync(donePath, 'OK\n');

  // 5. probe PASSES → converged (a real exit-code change)
  const a2 = await assess();
  assert.deepEqual(a2.unmet, []);
  assert.equal(a2.converged, true);

  // 6. belay stop → ALLOW silently (converged)
  const released = run(h, ['hook', 'stop'], { session_id: 's1', cwd: h.base });
  assert.equal(released.status, 0);
  assert.equal(released.stdout, '');
});
