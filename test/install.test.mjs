import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run } from './helpers.mjs';
import { isEphemeralInstall } from '../src/install.mjs';

// T2: install into a config dir that already carries tokenroom-style hooks —
// additive registration, idempotence, and an uninstall that restores EXACTLY.

const TOKENROOM_STYLE_SETTINGS = {
  statusLine: { type: 'command', command: '"node" "/opt/tokenroom/bin/tokenroom.mjs" tap' },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"node" "/opt/tokenroom/bin/tokenroom.mjs" hook user-prompt-submit', timeout: 10 }] }],
    PreToolUse: [{ matcher: 'Task|Agent|Workflow', hooks: [{ type: 'command', command: '"node" "/opt/tokenroom/bin/tokenroom.mjs" hook pre-tool-use', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'some-other-tool --on-stop' }] }],
  },
  permissions: { allow: ['Bash(ls:*)'] },
};

function seeded() {
  const h = homes();
  mkdirSync(h.config, { recursive: true });
  writeFileSync(join(h.config, 'settings.json'), JSON.stringify(TOKENROOM_STYLE_SETTINGS, null, 2) + '\n');
  return h;
}

const settingsOf = (h) => JSON.parse(readFileSync(join(h.config, 'settings.json'), 'utf8'));

test('install is additive: every pre-existing hook (tokenroom included) survives; conductor entries land once', () => {
  const h = seeded();
  const r = run(h, ['install', '--config-dir', h.config]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hook Stop: installed/);
  assert.match(r.stdout, /hook PreToolUse: installed/);

  const s = settingsOf(h);
  // pre-existing surface untouched
  assert.equal(s.statusLine.command, TOKENROOM_STYLE_SETTINGS.statusLine.command);
  assert.deepEqual(s.permissions, TOKENROOM_STYLE_SETTINGS.permissions);
  assert.deepEqual(s.hooks.UserPromptSubmit, TOKENROOM_STYLE_SETTINGS.hooks.UserPromptSubmit);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, TOKENROOM_STYLE_SETTINGS.hooks.PreToolUse[0].hooks[0].command);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'some-other-tool --on-stop');
  // conductor entries appended
  assert.equal(s.hooks.Stop.length, 2);
  assert.match(s.hooks.Stop[1].hooks[0].command, /conductor\.mjs" hook stop/);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.match(s.hooks.PreToolUse[1].hooks[0].command, /conductor\.mjs" hook pre-tool-use/);
  assert.equal(s.hooks.PreToolUse[1].matcher, undefined); // gate sees all tools by design
  // backup written
  assert.ok(existsSync(join(h.config, 'settings.json.conductor-bak')));
});

test('install is idempotent: second run replaces nothing and duplicates nothing', () => {
  const h = seeded();
  run(h, ['install', '--config-dir', h.config]);
  const first = settingsOf(h);
  const r = run(h, ['install', '--config-dir', h.config]);
  assert.match(r.stdout, /hook Stop: already installed/);
  assert.match(r.stdout, /hook PreToolUse: already installed/);
  assert.deepEqual(settingsOf(h), first);
});

test('--dry-run changes nothing on disk', () => {
  const h = seeded();
  const before = readFileSync(join(h.config, 'settings.json'), 'utf8');
  const r = run(h, ['install', '--config-dir', h.config, '--dry-run']);
  assert.match(r.stdout, /\[dry-run\]/);
  assert.equal(readFileSync(join(h.config, 'settings.json'), 'utf8'), before);
  assert.ok(!existsSync(join(h.config, 'settings.json.conductor-bak')));
});

test('uninstall removes ONLY conductor entries and restores the seeded settings exactly', () => {
  const h = seeded();
  run(h, ['install', '--config-dir', h.config]);
  const r = run(h, ['uninstall', '--config-dir', h.config]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hook Stop: removed/);
  assert.match(r.stdout, /hook PreToolUse: removed/);
  assert.deepEqual(settingsOf(h), TOKENROOM_STYLE_SETTINGS);
});

test('install into an EMPTY config dir, then uninstall → hooks key fully gone again', () => {
  const h = homes();
  run(h, ['install', '--config-dir', h.config]);
  const s = settingsOf(h);
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.PreToolUse.length, 1);
  run(h, ['uninstall', '--config-dir', h.config]);
  assert.deepEqual(settingsOf(h), {});
});

test('npx cache paths are recognized as ephemeral (installer refuses them)', () => {
  assert.equal(isEphemeralInstall('/Users/x/.npm/_npx/abc123/node_modules/conductor'), true);
  assert.equal(isEphemeralInstall('C:\\Users\\x\\AppData\\_npx\\abc\\conductor'), true);
  assert.equal(isEphemeralInstall('/Users/x/Development/conductor'), false);
});

test('doctor and status run clean (exit 0) against synthetic homes', () => {
  const h = homes();
  mkdirSync(h.keyoku, { recursive: true });
  const d = run(h, ['doctor']);
  assert.equal(d.status, 0);
  assert.match(d.stdout, /keyoku/);
  assert.match(d.stdout, /Stop hook NOT registered/);
  const s = run(h, ['status']);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /no focused goal — conductor idles/);
});
