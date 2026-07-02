import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Installer discipline mirrors tokenroom's: a MARK string identifies the entries we own,
// install is ADDITIVE (every pre-existing hook — tokenroom's included — is preserved),
// re-install replaces-not-duplicates, settings.json is backed up first, and npx-cache
// paths are refused because they evaporate. The MCP registration step (DESIGN §2.1) goes
// through the official `claude mcp add` CLI only — belay never edits ~/.claude.json itself.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binPath = join(pkgRoot, 'bin', 'belay.mjs');
export const MARK = 'belay.mjs'; // identifies hook commands we own in settings.json

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
  ['SessionStart', 'hook session-start', 'morning briefing: surfaces open loop proposals as additionalContext (advisory, never armed here)'],
];

// ── MCP registration (DESIGN §2.1, ADR-9) — via the official `claude` CLI only ─────────
// Skipped in a sandboxed config dir (--config-dir / $CLAUDE_CONFIG_DIR): `claude mcp add
// --scope user` writes the REAL ~/.claude.json, which a sandboxed run must never touch.

const manualMcpAdd = () => `claude mcp add --scope user belay "${process.execPath}" "${binPath}" mcp`;
const sandboxed = (argv) => configDir(argv) !== join(homedir(), '.claude');
const belayMcpRegistered = () => {
  const cj = readSettings(join(homedir(), '.claude.json'));
  return !!(cj.mcpServers && typeof cj.mcpServers === 'object' && cj.mcpServers.belay);
};

function registerMcp(argv, dry) {
  if (argv.includes('--no-mcp')) return 'mcp: skipped (--no-mcp)';
  if (sandboxed(argv)) return `mcp: skipped (sandboxed config dir) — register manually: ${manualMcpAdd()}`;
  if (belayMcpRegistered()) return 'mcp: already registered (~/.claude.json mcpServers.belay)';
  if (dry) return `mcp: would run: ${manualMcpAdd()}`;
  try {
    const r = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'belay', process.execPath, binPath, 'mcp'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return `mcp: \`claude\` CLI unavailable or failed — register manually: ${manualMcpAdd()}`;
    return 'mcp: registered (claude mcp add --scope user belay … mcp)';
  } catch {
    return `mcp: \`claude\` CLI unavailable — register manually: ${manualMcpAdd()}`;
  }
}

function unregisterMcp(argv) {
  if (argv.includes('--no-mcp')) return 'mcp: skipped (--no-mcp)';
  if (sandboxed(argv)) return 'mcp: skipped (sandboxed config dir) — remove manually: claude mcp remove --scope user belay';
  if (!belayMcpRegistered()) return 'mcp: not registered — nothing to remove';
  try {
    const r = spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'belay'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return 'mcp: `claude` CLI unavailable or failed — remove manually: claude mcp remove --scope user belay';
    return 'mcp: removed (claude mcp remove --scope user belay)';
  } catch {
    return 'mcp: `claude` CLI unavailable — remove manually: claude mcp remove --scope user belay';
  }
}

export function install(argv = []) {
  if (isEphemeralInstall(pkgRoot)) {
    console.error(
      'belay install: refusing to install from the npx cache.\n' +
        'npx runs from an evictable cache directory; the absolute paths written into\n' +
        'settings.json would silently break when npm prunes it. Install persistently:\n' +
        '  npm install -g <this package> && belay install\n' +
        'or clone the repo and run: node bin/belay.mjs install'
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
  if (!dry && existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.belay-bak');

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

  changes.push(registerMcp(argv, dry));

  console.log(`${dry ? '[dry-run] ' : ''}belay install → ${dir}`);
  for (const c of changes) console.log('  - ' + c);
  if (!dry)
    console.log(
      '\nDone. Belay is a no-op until a Keyoku goal is focused with autonomy "autonomous".\nRun `belay doctor` to verify the keyoku/tokenroom wiring.'
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

  changes.push(unregisterMcp(argv));

  console.log(`belay uninstall ← ${dir}`);
  for (const c of changes.length ? changes : ['nothing to remove']) console.log('  - ' + c);
  console.log('\nOnly belay entries were removed; everything else in settings.json is untouched.\nLocal data in ~/.belay was kept; delete it manually for a clean slate.');
}
