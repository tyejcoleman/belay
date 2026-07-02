import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run } from './helpers.mjs';

// T2: `belay bundle` wires the whole autonomous stack in one command. Every assertion is
// spawn-based against a temp CLAUDE_CONFIG_DIR seeded with PRE-EXISTING tokenroom-style
// hooks — the exact clobber risk the bundle must not trip.

const TOKENROOM_STYLE_SETTINGS = {
  statusLine: { type: 'command', command: '"node" "/opt/tokenroom/bin/tokenroom.mjs" tap' },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"node" "/opt/tokenroom/bin/tokenroom.mjs" hook user-prompt-submit', timeout: 10 }] }],
    PreToolUse: [{ matcher: 'Task|Agent|Workflow', hooks: [{ type: 'command', command: '"node" "/opt/tokenroom/bin/tokenroom.mjs" hook pre-tool-use', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'some-other-tool --on-stop' }] }],
  },
  permissions: { allow: ['Bash(ls:*)'] },
};

const KEYOKU_CLAUDE_JSON = { mcpServers: { keyoku: { command: 'node', args: ['/x/keyoku-harness/dist/index.js'] } } };

// A stub that stands in for tokenroom's installer: records that it ran (and with which
// args) into a marker file, so the test can prove `belay bundle` DETECTED and INVOKED it.
const TOKENROOM_STUB = `const a = process.argv.slice(2);
const i = a.indexOf('--config-dir');
const dir = i >= 0 ? a[i + 1] : '.';
require('node:fs').writeFileSync(dir + '/tokenroom-installed.marker', 'stub ran: ' + a.join(' '));
console.log('tokenroom install (stub) → ' + dir + (a.includes('--dry-run') ? ' [dry-run]' : ''));
`;

function seeded({ keyoku = true } = {}) {
  const h = homes();
  mkdirSync(h.config, { recursive: true });
  writeFileSync(join(h.config, 'settings.json'), JSON.stringify(TOKENROOM_STYLE_SETTINGS, null, 2) + '\n');
  if (keyoku) writeFileSync(join(h.config, '.claude.json'), JSON.stringify(KEYOKU_CLAUDE_JSON));
  const stub = join(h.base, 'fake-tokenroom.cjs');
  writeFileSync(stub, TOKENROOM_STUB);
  return { h, stub };
}

const settingsOf = (h) => JSON.parse(readFileSync(join(h.config, 'settings.json'), 'utf8'));
const belayEntries = (h, event) => (settingsOf(h).hooks[event] || []).filter((m) => (m?.hooks ?? []).some((x) => String(x?.command).includes('belay.mjs')));

test('bundle: three legs run, tokenroom installer is invoked, belay hooks land ADDITIVELY', () => {
  const { h, stub } = seeded();
  const r = run(h, ['bundle', '--tokenroom', stub]);
  assert.equal(r.status, 0);

  // leg 1 — tokenroom detected + invoked (marker proves the child installer actually ran)
  assert.match(r.stdout, /1\) tokenroom/);
  assert.match(r.stdout, new RegExp(`found: ${stub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.stdout, /tokenroom install \(stub\)/); // the child's own output, forwarded
  assert.match(r.stdout, /tokenroom installer completed/);
  const marker = join(h.config, 'tokenroom-installed.marker');
  assert.ok(existsSync(marker), 'stub installer must have run');
  assert.match(readFileSync(marker, 'utf8'), /--config-dir/, 'belay forwards --config-dir to tokenroom');

  // leg 2 — keyoku verified as registered, READ-ONLY (never modified)
  assert.match(r.stdout, /2\) keyoku/);
  assert.match(r.stdout, /MCP server registered/);
  assert.match(r.stdout, /verification only — belay never modifies keyoku/);
  assert.deepEqual(JSON.parse(readFileSync(join(h.config, '.claude.json'), 'utf8')), KEYOKU_CLAUDE_JSON, 'keyoku registration untouched');

  // leg 3 — belay hooks installed, PRE-EXISTING hooks preserved
  assert.match(r.stdout, /3\) belay/);
  const s = settingsOf(h);
  assert.equal(s.statusLine.command, TOKENROOM_STYLE_SETTINGS.statusLine.command);
  assert.deepEqual(s.hooks.UserPromptSubmit, TOKENROOM_STYLE_SETTINGS.hooks.UserPromptSubmit);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, TOKENROOM_STYLE_SETTINGS.hooks.PreToolUse[0].hooks[0].command);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Task|Agent|Workflow');
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'some-other-tool --on-stop');
  assert.equal(belayEntries(h, 'Stop').length, 1);
  assert.equal(belayEntries(h, 'PreToolUse').length, 1);
  assert.match(belayEntries(h, 'Stop')[0].hooks[0].command, /belay\.mjs" hook stop/);

  // summary + next steps to arm an autonomous loop
  assert.match(r.stdout, /stack health/);
  assert.match(r.stdout, /next steps: arm an autonomous loop/);
  assert.match(r.stdout, /goal_create/);
  assert.match(r.stdout, /goal_focus/);
  assert.match(r.stdout, /autonomy to `autonomous`/);
});

test('bundle is idempotent: re-run replaces nothing, duplicates nothing', () => {
  const { h, stub } = seeded();
  run(h, ['bundle', '--tokenroom', stub]);
  const first = settingsOf(h);
  const r = run(h, ['bundle', '--tokenroom', stub]);
  assert.match(r.stdout, /hook Stop: already installed/);
  assert.match(r.stdout, /hook PreToolUse: already installed/);
  assert.equal(belayEntries(h, 'Stop').length, 1);
  assert.equal(belayEntries(h, 'PreToolUse').length, 1);
  assert.deepEqual(settingsOf(h), first, 'second bundle must not change settings.json');
});

test('bundle --dry-run touches nothing on disk', () => {
  const { h, stub } = seeded();
  const before = readFileSync(join(h.config, 'settings.json'), 'utf8');
  const r = run(h, ['bundle', '--dry-run', '--tokenroom', stub]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[dry-run\]/);
  assert.equal(readFileSync(join(h.config, 'settings.json'), 'utf8'), before, 'settings.json unchanged');
  assert.ok(!existsSync(join(h.config, 'settings.json.belay-bak')), 'no backup written on dry-run');
});

test('bundle with tokenroom absent: clear "install first" note, then STILL installs belay additively', () => {
  const { h } = seeded();
  // point at a path that does not exist → deterministically "not resolvable" (no PATH fallback)
  const r = run(h, ['bundle', '--tokenroom', join(h.base, 'nope', 'tokenroom.mjs')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /does not exist/);
  assert.match(r.stdout, /install tokenroom first/);
  assert.match(r.stdout, /continuing without it/);
  // belay still wired, tokenroom's pre-existing Stop hook still present
  assert.equal(belayEntries(h, 'Stop').length, 1);
  assert.equal(settingsOf(h).hooks.Stop[0].hooks[0].command, 'some-other-tool --on-stop');
});

test('doctor opens with the full-stack health view', () => {
  const { h } = seeded();
  run(h, ['bundle', '--tokenroom', join(h.base, 'nope.mjs')]); // install belay hooks first
  const d = run(h, ['doctor']);
  assert.equal(d.status, 0);
  assert.match(d.stdout, /stack \(tokenroom \+ keyoku \+ belay\)/);
  assert.match(d.stdout, /belay: Stop \+ PreToolUse hooks registered/);
  assert.match(d.stdout, /keyoku: registered/); // from the seeded .claude.json
});
