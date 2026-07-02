import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homes, writeClaudeJson, fakeKeyokuBin } from './helpers.mjs';

// T1: the ADR-10 write path — resolve the REGISTERED keyoku server spec verbatim, drive it
// as a short-lived newline-JSON-RPC child (handshake, per-call timeout kill, sanitized
// errors, env passthrough-but-never-echoed). fake-keyoku is the frozen fixture double.

const { resolveKeyokuServer, keyokuSession } = await import('../src/keyoku-client.mjs');

/** Run fn with process.env temporarily overridden (undefined value = delete). */
async function withEnv(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) {
    saved[k] = process.env[k];
    if (over[k] === undefined) delete process.env[k];
    else process.env[k] = over[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(over)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** A hermetic env base: CLAUDE_JSON pinned to a definite path inside the fixture world so
 *  claudeJsonPath can never fall back to the developer's real ~/.claude.json. */
const hermetic = (h, over = {}) => ({
  CLAUDE_JSON: join(h.config, '.claude.json'),
  CLAUDE_CONFIG_DIR: h.config,
  KEYOKU_INSTALL: undefined,
  KEYOKU_HOME: h.keyoku,
  BELAY_DIR: h.belay,
  ...over,
});

// ── resolveKeyokuServer ─────────────────────────────────────────────────────────────────

test('resolveKeyokuServer: registered spec returned verbatim ({command,args,env}, source = claude.json path)', async () => {
  const h = homes();
  const cjPath = writeClaudeJson(h);
  await withEnv(hermetic(h), () => {
    const r = resolveKeyokuServer();
    assert.equal(r.ok, true);
    assert.equal(r.command, process.execPath);
    assert.deepEqual(r.args, [fakeKeyokuBin]);
    assert.deepEqual(r.env, { KEYOKU_HOME: h.keyoku }); // verbatim, untouched
    assert.equal(r.source, cjPath);
  });
});

test('resolveKeyokuServer: per-project mcpServers blocks are searched too (same walk as stack.mjs)', async () => {
  const h = homes();
  mkdirSync(h.config, { recursive: true });
  const cjPath = join(h.config, '.claude.json');
  writeFileSync(
    cjPath,
    JSON.stringify({ projects: { '/some/proj': { mcpServers: { keyoku: { type: 'stdio', command: 'node', args: ['/x/dist/index.js'], env: {} } } } } })
  );
  await withEnv(hermetic(h), () => {
    const r = resolveKeyokuServer();
    assert.equal(r.ok, true);
    assert.equal(r.command, 'node');
    assert.deepEqual(r.args, ['/x/dist/index.js']);
  });
});

test('resolveKeyokuServer: not registered → { ok:false, error:"keyoku MCP server not registered" }; never throws on garbage', async () => {
  const h = homes();
  await withEnv(hermetic(h), () => {
    assert.deepEqual(resolveKeyokuServer(), { ok: false, error: 'keyoku MCP server not registered' }); // file absent
    mkdirSync(h.config, { recursive: true });
    writeFileSync(join(h.config, '.claude.json'), '{not json');
    assert.equal(resolveKeyokuServer().ok, false); // malformed → same degrade (ADR-4)
    writeFileSync(join(h.config, '.claude.json'), JSON.stringify({ mcpServers: { keyoku: { args: ['no-command.js'] } } }));
    assert.equal(resolveKeyokuServer().ok, false); // spec without a command string is unusable
  });
});

test('resolveKeyokuServer: $KEYOKU_INSTALL/dist/index.js fallback when nothing is registered', async () => {
  const h = homes();
  const install = join(h.base, 'keyoku-install');
  mkdirSync(join(install, 'dist'), { recursive: true });
  writeFileSync(join(install, 'dist', 'index.js'), '// keyoku entry\n');
  await withEnv(hermetic(h, { KEYOKU_INSTALL: install }), () => {
    const r = resolveKeyokuServer();
    assert.equal(r.ok, true);
    assert.equal(r.command, process.execPath);
    assert.deepEqual(r.args, [join(install, 'dist', 'index.js')]);
    assert.equal(r.source, 'KEYOKU_INSTALL');
  });
  // registered spec WINS over the fallback
  writeClaudeJson(h);
  await withEnv(hermetic(h, { KEYOKU_INSTALL: install }), () => {
    assert.equal(resolveKeyokuServer().source, join(h.config, '.claude.json'));
  });
});

// ── keyokuSession: the live child path against fake-keyoku ────────────────────────────

test('keyokuSession: handshake + multiple tools/call on ONE child; result.content[0].text parsed; spec.env reaches the child', async () => {
  const h = homes();
  writeClaudeJson(h); // registers fake-keyoku with env.KEYOKU_HOME = h.keyoku
  await withEnv(hermetic(h), async () => {
    const s = await keyokuSession();
    try {
      const created = await s.call('goal_create', {
        objective: 'ship the client',
        criteria: [{ description: 'tests green', probe: { kind: 'command', command: 'true' }, assert: { op: 'eq', value: 0 } }],
        autonomy: 'autonomous',
      });
      assert.equal(created.goal.autonomy, 'autonomous');
      assert.equal(created.goal.status, 'active');
      // the registered env was passed through: the child wrote THIS world's goals.json
      const rows = JSON.parse(readFileSync(join(h.keyoku, 'goals.json'), 'utf8'));
      assert.equal(rows[0].id, created.goal.id);

      const updated = await s.call('goal_update', { goal: created.goal.id, autonomy: 'suggest' });
      assert.equal(updated.goal.autonomy, 'suggest');

      const focused = await s.call('goal_focus', { goal: created.goal.id, cwd: '/tmp/proj', sessionId: 's1' });
      assert.equal(focused.focus.goalId, created.goal.id);
      assert.equal(JSON.parse(readFileSync(join(h.keyoku, 'focus.json'), 'utf8')).sessionId, 's1');
    } finally {
      await s.close(); // stdin end → fake exits 0, like real keyoku serve()
    }
  });
});

test("keyokuSession: keyoku's own validation errors return VERBATIM as parsed {error} (single validator, no re-validation)", async () => {
  const h = homes();
  writeClaudeJson(h);
  await withEnv(hermetic(h), async () => {
    const s = await keyokuSession();
    try {
      const out = await s.call('goal_create', { objective: 'no criteria' }); // fake's zod-ish refusal
      assert.equal(out.error, 'goal_create: objective and criteria[] are required');
    } finally {
      await s.close();
    }
  });
});

test('keyokuSession: JSON-RPC-level error (unknown tool -32602) rejects with a sanitized Error', async () => {
  const h = homes();
  writeClaudeJson(h);
  await withEnv(hermetic(h), async () => {
    const s = await keyokuSession();
    try {
      await assert.rejects(s.call('goal_assess', {}), (e) => {
        assert.match(e.message, /keyoku goal_assess failed/);
        assert.doesNotMatch(e.message, /[\n\r]/); // single-line (ADR-7)
        return true;
      });
      // the session survives an rpc error — next call still answers
      const out = await s.call('goal_unfocus', {});
      assert.equal(out.focus, null);
    } finally {
      await s.close();
    }
  });
});

test('keyokuSession: not registered → rejects with the exact ADR-10 error, no child spawned', async () => {
  const h = homes();
  await withEnv(hermetic(h), async () => {
    await assert.rejects(keyokuSession(), /keyoku MCP server not registered/);
  });
});

test('keyokuSession: hung server → per-call hard timeout, child KILLED, sanitized rejection (never a wedge)', async () => {
  const h = homes();
  // a "server" that reads stdin but never answers anything
  writeClaudeJson(h, { keyokuCmd: { type: 'stdio', command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], env: {} } });
  const t0 = Date.now();
  await withEnv(hermetic(h), async () => {
    await assert.rejects(keyokuSession({ timeoutMs: 300 }), (e) => {
      assert.match(e.message, /timed out after 300ms \(child killed\)/);
      assert.doesNotMatch(e.message, /[\n\r]/);
      return true;
    });
  });
  assert.ok(Date.now() - t0 < 5000, 'timeout fired at ~300ms, not at some larger default');
});

test('keyokuSession: child that exits immediately → prompt sanitized rejection carrying single-line stderr, NEVER the env', async () => {
  const h = homes();
  writeClaudeJson(h, {
    keyokuCmd: {
      type: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom line one\\nboom line two\\n"); process.exit(7)'],
      env: { SUPER_SECRET_TOKEN: 'hunter2-do-not-echo' },
    },
  });
  await withEnv(hermetic(h), async () => {
    await assert.rejects(keyokuSession({ timeoutMs: 5000 }), (e) => {
      assert.match(e.message, /keyoku child exited \(code 7\)/);
      assert.match(e.message, /boom line one/); // stderr surfaced for diagnosis…
      assert.doesNotMatch(e.message, /[\n\r]/); // …but sanitized to one line (ADR-7)
      assert.doesNotMatch(e.message, /hunter2/); // and the registered env is NEVER echoed
      return true;
    });
  });
});

test('keyokuSession: unspawnable command → rejects (spawn error), no throw escapes the promise', async () => {
  const h = homes();
  writeClaudeJson(h, { keyokuCmd: { type: 'stdio', command: join(h.base, 'no-such-binary'), args: [], env: {} } });
  await withEnv(hermetic(h), async () => {
    await assert.rejects(keyokuSession({ timeoutMs: 3000 }), (e) => {
      assert.match(e.message, /keyoku child/);
      assert.doesNotMatch(e.message, /[\n\r]/);
      return true;
    });
  });
});
