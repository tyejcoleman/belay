import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, env, writeLoops, writeProposals, writeResume, writeRipe, writeClaudeJson, fakeKeyokuSession, nowSec } from './helpers.mjs';

// Round-0 scaffold gates (docs/DESIGN.md §6.0): the FROZEN contracts every fill agent
// codes against — tool schemas, bin dispatch, stub signatures, fixture server, helpers.

// ── MCP tool registry (the §2.2 contract) ──────────────────────────────────────────────

const EXPECTED_TOOLS = ['belay_status', 'belay_loop_create', 'belay_loop_list', 'belay_loop_pause', 'belay_loop_resume', 'belay_loop_disarm', 'belay_propose'];

test('TOOLS: exactly the 7 designed tools, valid frozen JSON schemas', async () => {
  const { TOOLS, PROTOCOL_VERSION, SERVER_INFO } = await import('../src/mcp.mjs');
  assert.deepEqual(TOOLS.map((t) => t.name), EXPECTED_TOOLS);
  for (const t of TOOLS) {
    assert.ok(typeof t.description === 'string' && t.description.length > 20, `${t.name} has a description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema is an object schema`);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} schema closes additionalProperties`);
    assert.deepEqual(JSON.parse(JSON.stringify(t)), t, `${t.name} round-trips as JSON`);
  }
  // required fields per §2.2
  for (const name of ['belay_loop_pause', 'belay_loop_resume', 'belay_loop_disarm']) {
    assert.deepEqual(TOOLS.find((t) => t.name === name).inputSchema.required, ['goal']);
  }
  assert.equal(PROTOCOL_VERSION, '2025-06-18');
  assert.equal(SERVER_INFO.name, 'belay');
});

// ── Frozen interfaces: every round-0 signature is exported and implemented ─────────────
// (Round 0 asserted these all threw ERR_NOT_IMPLEMENTED; at integrate the same frozen
// names must exist as real functions — behavior is covered by each module's own suite.)

test('frozen signatures: every round-0 contract export exists as a function (stubs gone)', async () => {
  const mcp = await import('../src/mcp.mjs');
  const compose = await import('../src/compose.mjs');
  const kc = await import('../src/keyoku-client.mjs');
  const loops = await import('../src/loops.mjs');
  const propose = await import('../src/propose.mjs');
  const ss = await import('../src/session-start.mjs');
  for (const [mod, name] of [
    [mcp, 'mcpServe'],
    [compose, 'buildStatus'],
    [compose, 'buildLoopList'],
    [kc, 'resolveKeyokuServer'],
    [kc, 'keyokuSession'],
    [loops, 'loopCreate'],
    [loops, 'loopPause'],
    [loops, 'loopResume'],
    [loops, 'loopDisarm'],
    [loops, 'readLoops'],
    [propose, 'scan'],
    [propose, 'dismiss'],
    [ss, 'hookSessionStart'],
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} is exported and implemented`);
    assert.ok(!/ERR_NOT_IMPLEMENTED/.test(String(mod[name])), `${name} is no longer a round-0 stub`);
  }
});

test('loops.readLoops: implemented round 0 — absent/malformed degrades to {loops:{}}', async () => {
  const h = homes();
  const prevDir = process.env.BELAY_DIR;
  process.env.BELAY_DIR = h.belay;
  try {
    const { readLoops } = await import('../src/loops.mjs');
    assert.deepEqual(readLoops(), { loops: {} }); // absent
    writeLoops(h, '{not json');
    assert.deepEqual(readLoops(), { loops: {} }); // malformed
    writeLoops(h, { goal_x: { paused: true } });
    const s = readLoops();
    assert.equal(s.loops.goal_x.paused, true);
    assert.equal(s.loops.goal_x.armed, true); // helper default per §3.1
  } finally {
    if (prevDir === undefined) delete process.env.BELAY_DIR;
    else process.env.BELAY_DIR = prevDir;
  }
});

// ── bin dispatch: every verb reaches its implemented handler (stub era over) ───────────

test('bin: new verbs dispatch to the implemented handlers (exit 0, JSON out, no stub trace)', () => {
  const h = homes();
  // `belay mcp` serves stdio and shuts down clean when stdin ends (run() closes it).
  const mcp = run(h, ['mcp'], '');
  assert.equal(mcp.status, 0, 'belay mcp exits clean on stdin end');
  assert.doesNotMatch(mcp.stderr, /not implemented/i);
  // JSON-printing verbs: each answers from the real handler (refusals are ok:false
  // RESULTS, not crashes — hermetic homes have no goals and no registered keyoku).
  for (const args of [['loop', 'list'], ['loop', 'pause', 'g1'], ['loop', 'resume', 'g1'], ['loop', 'disarm', 'g1'], ['loop', 'create', '--objective', 'x', '--criteria', '[]'], ['propose'], ['propose', '--dismiss', 'p1']]) {
    const r = run(h, args);
    assert.equal(r.status, 0, `belay ${args.join(' ')} exits 0 (got stderr: ${r.stderr.slice(0, 200)})`);
    assert.doesNotMatch(r.stderr, /not implemented/i, `belay ${args.join(' ')} reaches the implementation`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `belay ${args.join(' ')} prints JSON`);
  }
});

test('bin: loop create is HERMETIC — unregistered world fails closed; the registered server must BE the fixture (refute-audit F1)', () => {
  // No .claude.json exists in this world's config dir: resolution must fail closed even
  // on a machine whose real ~/.claude.json registers keyoku — proves the write path can
  // never fall through to the developer's live server from a hermetic world.
  const h = homes();
  const bare = JSON.parse(run(h, ['loop', 'create', '--objective', 'x', '--criteria', '[{"description":"d"}]', '--session-id', 's1']).stdout);
  assert.equal(bare.ok, false);
  assert.equal(bare.step, 'spawn');
  assert.equal(bare.error, 'keyoku MCP server not registered');
  assert.equal(existsSync(join(h.keyoku, 'goals.json')), false, 'no keyoku process ever ran in this world');

  // With fake-keyoku registered, the refusal text must be the FIXTURE's distinctive
  // wording — real keyoku's zod message differs ('A goal needs at least one
  // machine-checkable criterion…'), so this fails loudly if the resolved server is
  // anything but the fixture.
  const h2 = homes();
  writeClaudeJson(h2);
  const fx = JSON.parse(run(h2, ['loop', 'create', '--objective', 'x', '--criteria', '[]', '--session-id', 's1']).stdout);
  assert.equal(fx.ok, false);
  assert.equal(fx.step, 'create');
  assert.match(fx.error, /goal_create: objective and criteria\[\] are required/);
});

test('bin: `belay loop` without a known subverb prints usage, exit 2', () => {
  const h = homes();
  const r = run(h, ['loop']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /create\|list\|pause\|resume\|disarm/);
});

test('bin: `belay loop create` rejects malformed --criteria JSON before touching handlers', () => {
  const h = homes();
  const r = run(h, ['loop', 'create', '--objective', 'x', '--criteria', '{nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be valid JSON/);
});

test('bin: hook session-start with zero proposals is silent exit 0 (never-crash rule)', () => {
  const h = homes();
  const r = run(h, ['hook', 'session-start'], {});
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('bin: doctor still runs green with the scaffold in place', () => {
  const h = homes();
  const r = run(h, ['doctor']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /belay doctor/i);
});

// ── fake-keyoku fixture server (the shared write-path test double) ─────────────────────

test('fake-keyoku: initialize echoes protocolVersion; goal_create/update/focus/unfocus mutate KEYOKU_HOME like real keyoku', async () => {
  const h = homes();
  const s = fakeKeyokuSession(h);
  try {
    const init = await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'belay-test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'keyoku-fake');
    s.notify('notifications/initialized');

    // create → whole-array goals.json write, row shape per types.ts:156-171
    const created = await s.call('tools/call', {
      name: 'goal_create',
      arguments: { objective: 'ship the scaffold', criteria: [{ description: 'tests green', probe: { kind: 'command', command: 'npm test' }, assert: { op: 'eq', value: 0 } }], autonomy: 'autonomous', maxIterations: 10 },
    });
    const row = JSON.parse(created.result.content[0].text).goal;
    assert.equal(row.autonomy, 'autonomous');
    assert.equal(row.status, 'active');
    assert.equal(row.criteria[0].id, 'c1');
    const goals = JSON.parse(readFileSync(join(h.keyoku, 'goals.json'), 'utf8'));
    assert.equal(goals.length, 1);
    assert.equal(goals[0].id, row.id);

    // update mutates in place (read-modify-write)
    await s.call('tools/call', { name: 'goal_update', arguments: { goal: row.id, autonomy: 'suggest' } });
    assert.equal(JSON.parse(readFileSync(join(h.keyoku, 'goals.json'), 'utf8'))[0].autonomy, 'suggest');

    // focus writes the global-singleton focus.json shape
    await s.call('tools/call', { name: 'goal_focus', arguments: { goal: row.slug, cwd: '/tmp/proj', sessionId: 's1' } });
    const focus = JSON.parse(readFileSync(join(h.keyoku, 'focus.json'), 'utf8'));
    assert.deepEqual({ goalId: focus.goalId, goalSlug: focus.goalSlug, cwd: focus.cwd, sessionId: focus.sessionId }, { goalId: row.id, goalSlug: row.slug, cwd: '/tmp/proj', sessionId: 's1' });

    // unfocus clears it
    await s.call('tools/call', { name: 'goal_unfocus', arguments: {} });
    assert.equal(existsSync(join(h.keyoku, 'focus.json')), false);

    // refusals: bad create is an isError result; unknown tool is -32602; garbage survives
    const bad = await s.call('tools/call', { name: 'goal_create', arguments: { objective: 'no criteria' } });
    assert.equal(bad.result.isError, true);
    const unk = await s.call('tools/call', { name: 'goal_assess', arguments: {} });
    assert.equal(unk.error.code, -32602);
    s.send('{torn garbage');
    const alive = await s.call('tools/list');
    assert.deepEqual(alive.result.tools.map((t) => t.name), ['goal_create', 'goal_update', 'goal_focus', 'goal_unfocus']);
  } finally {
    const { code } = await s.close();
    assert.equal(code, 0); // shuts down on stdin end, like real keyoku serve()
  }
});

// ── new fixture helpers land the §3.1/§4.1 shapes at the designed paths ────────────────

test('helpers: writeLoops/writeProposals/writeResume/writeRipe/writeClaudeJson write the designed shapes', () => {
  const h = homes();
  writeLoops(h, { goal_a: { armed_by: 'proposal:p1' } });
  const loops = JSON.parse(readFileSync(join(h.belay, 'loops.json'), 'utf8'));
  assert.deepEqual(Object.keys(loops.loops), ['goal_a']);
  assert.equal(loops.loops.goal_a.armed, true);
  assert.equal(loops.loops.goal_a.armed_by, 'proposal:p1');

  writeProposals(h, [{ kind: 'resume-ready', summary: 'finish it' }]);
  const props = JSON.parse(readFileSync(join(h.belay, 'proposals.json'), 'utf8'));
  assert.equal(props.proposals[0].kind, 'resume-ready');
  assert.equal(props.proposals[0].status, 'open');

  writeResume(h, { summary: 'deferred', resumeAtAgoSec: 30 });
  const resume = JSON.parse(readFileSync(join(h.tokenroom, 'resume.json'), 'utf8'));
  assert.equal(resume.summary, 'deferred');
  assert.ok(resume.resume_at <= nowSec());

  writeRipe(h, [{ goalId: 'g1', reason: 'ripe' }]);
  const ripe = JSON.parse(readFileSync(join(h.keyoku, 'ripe.json'), 'utf8'));
  assert.equal(ripe.suggestions.length, 1);

  const cjPath = writeClaudeJson(h);
  const cj = JSON.parse(readFileSync(cjPath, 'utf8'));
  assert.equal(cj.mcpServers.keyoku.env.KEYOKU_HOME, h.keyoku);
  assert.ok(cj.mcpServers.keyoku.args[0].endsWith('fake-keyoku.mjs'));
});

test('helpers: writeClaudeJson is found by stack.mjs via CLAUDE_CONFIG_DIR (doctor sees keyoku registered)', () => {
  const h = homes();
  writeClaudeJson(h);
  const r = run(h, ['doctor']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /keyoku: registered/i);
});
