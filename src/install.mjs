import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Installer discipline mirrors tokenroom's: a MARK string identifies the entries we own,
// install is ADDITIVE (every pre-existing hook — tokenroom's included — is preserved),
// re-install replaces-not-duplicates, settings.json is backed up first, and npx-cache
// paths are refused because they evaporate.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binPath = join(pkgRoot, 'bin', 'conductor.mjs');
export const MARK = 'conductor.mjs'; // identifies hook commands we own in settings.json

/** npx runs from an evictable cache — absolute paths written from there break later. */
export const isEphemeralInstall = (p) => p.includes('/_npx/') || p.includes('\\_npx\\');

const cmd = (sub) => `"${process.execPath}" "${binPath}" ${sub}`;

export function configDir(argv = []) {
  const i = argv.indexOf('--config-dir');
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

const readSettings = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
};

const owned = (command) => typeof command === 'string' && command.includes(MARK);

// No matcher on PreToolUse: the gate must see Bash, the spawn tools AND mcp send tools,
// and user ask_patterns can name anything. It exits in a few ms when no autonomous
// focus exists, which is the common case.
const HOOK_EVENTS = [
  ['Stop', 'hook stop', 'goal loop: holds the session while the focused autonomous Keyoku goal is unconverged'],
  ['PreToolUse', 'hook pre-tool-use', 'policy gate: autonomy x budget x action-class'],
];

export function install(argv = []) {
  if (isEphemeralInstall(pkgRoot)) {
    console.error(
      'conductor install: refusing to install from the npx cache.\n' +
        'npx runs from an evictable cache directory; the absolute paths written into\n' +
        'settings.json would silently break when npm prunes it. Install persistently:\n' +
        '  npm install -g <this package> && conductor install\n' +
        'or clone the repo and run: node bin/conductor.mjs install'
    );
    process.exitCode = 1;
    return;
  }
  const dry = argv.includes('--dry-run');
  const dir = configDir(argv);
  const settingsPath = join(dir, 'settings.json');
  const changes = [];

  mkdirSync(dir, { recursive: true });
  const settings = readSettings(settingsPath);
  if (!dry && existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.conductor-bak');

  settings.hooks ??= {};
  for (const [event, sub, label] of HOOK_EVENTS) {
    settings.hooks[event] ??= [];
    if (!Array.isArray(settings.hooks[event])) {
      changes.push(`hook ${event}: existing entry is not an array — left untouched, NOT installed (fix settings.json by hand)`);
      continue;
    }
    if (settings.hooks[event].some((m) => (m?.hooks ?? []).some((h) => owned(h?.command)))) {
      changes.push(`hook ${event}: already installed`);
    } else {
      settings.hooks[event].push({ hooks: [{ type: 'command', command: cmd(sub), timeout: 10 }] });
      changes.push(`hook ${event}: installed (${label})`);
    }
  }

  if (!dry) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  console.log(`${dry ? '[dry-run] ' : ''}conductor install → ${dir}`);
  for (const c of changes) console.log('  - ' + c);
  if (!dry)
    console.log(
      '\nDone. Conductor is a no-op until a Keyoku goal is focused with autonomy "autonomous".\nRun `conductor doctor` to verify the keyoku/tokenroom wiring.'
    );
}

export function uninstall(argv = []) {
  const dir = configDir(argv);
  const settingsPath = join(dir, 'settings.json');
  const changes = [];

  if (existsSync(settingsPath)) {
    const settings = readSettings(settingsPath);
    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const event of Object.keys(settings.hooks)) {
        if (!Array.isArray(settings.hooks[event])) continue;
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter((m) => !(m?.hooks ?? []).some((h) => owned(h?.command)));
        if (settings.hooks[event].length !== before) changes.push(`hook ${event}: removed`);
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  console.log(`conductor uninstall ← ${dir}`);
  for (const c of changes.length ? changes : ['nothing to remove']) console.log('  - ' + c);
  console.log('\nOnly conductor entries were removed; everything else in settings.json is untouched.\nLocal data in ~/.conductor was kept; delete it manually for a clean slate.');
}
