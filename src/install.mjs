import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

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

/**
 * Load settings.json for a WRITE, distinguishing absent from corrupt (ADR-20). Overwriting a
 * present-but-unparseable settings.json with a belay-only object destroys the user's entire
 * config (permissions, model, other hooks) with no recovery — install had a `.belay-bak`,
 * uninstall had nothing. So a parse failure on an EXISTING file returns { unparseable: true }
 * and the caller REFUSES to write. Absent file → a clean {} is fine.
 * @returns {{ settings: object|null, unparseable: boolean }}
 */
function loadSettingsForWrite(p) {
  if (!existsSync(p)) return { settings: {}, unparseable: false };
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'));
    if (o && typeof o === 'object' && !Array.isArray(o)) return { settings: o, unparseable: false };
    return { settings: null, unparseable: true }; // valid JSON but a scalar/array — refuse to clobber
  } catch {
    return { settings: null, unparseable: true };
  }
}

/** Atomic tmp+rename write so a crash mid-write never leaves a torn settings.json for the
 *  concurrent Claude Code sessions reading it (MCP-F2). */
function writeSettingsAtomic(p, settings) {
  const tmp = `${p}.${randomBytes(4).toString('hex')}.belay-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, p);
}

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
  const { settings, unparseable } = loadSettingsForWrite(settingsPath);
  if (unparseable) {
    console.error(
      `belay install: ${settingsPath} exists but is not a valid JSON object — refusing to overwrite it.\n` +
        'Overwriting would destroy your permissions/model/other hooks. Fix or move it, then re-run.'
    );
    process.exitCode = 1;
    return;
  }
  // A non-plain-object `hooks` (array or scalar) would silently drop belay's hooks: named
  // properties set on an array don't survive JSON.stringify, and a string throws (refute
  // F3/F7). Refuse rather than report "installed" for hooks that won't persist.
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks) || settings.hooks === null)) {
    console.error(
      `belay install: ${settingsPath} has a "hooks" field that is ${Array.isArray(settings.hooks) ? 'an array' : `a ${settings.hooks === null ? 'null' : typeof settings.hooks}`}, not an object — refusing to modify it (belay's hooks would be silently dropped and the fall-arrest would be absent). Fix "hooks" to an object, then re-run.`
    );
    process.exitCode = 1;
    return;
  }
  if (!dry && existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.belay-bak');

  settings.hooks ??= {};
  for (const [event, sub, label] of HOOK_EVENTS) {
    settings.hooks[event] ??= [];
    if (!Array.isArray(settings.hooks[event])) {
      changes.push(`hook ${event}: existing entry is not an array — left untouched, NOT installed (fix settings.json by hand)`);
      continue;
    }
    // Re-install REFRESHES, not just skips (MCP-F3): if an owned command exists but points at
    // a stale node/bin path (moved package, upgraded node), rewrite it to this install's path
    // so the hook can't silently fail forever while doctor reports it "registered".
    const want = cmd(sub);
    let found = false;
    let refreshed = false;
    for (const m of settings.hooks[event]) {
      for (const h of m?.hooks ?? []) {
        if (!owned(h?.command)) continue;
        found = true;
        if (h.command !== want) {
          h.command = want;
          refreshed = true;
        }
        if (h.type !== 'command') h.type = 'command';
        if (typeof h.timeout !== 'number') h.timeout = 10;
      }
    }
    if (!found) {
      settings.hooks[event].push({ hooks: [{ type: 'command', command: want, timeout: 10 }] });
      changes.push(`hook ${event}: installed (${label})`);
    } else if (refreshed) {
      changes.push(`hook ${event}: refreshed (command path updated to this install)`);
    } else {
      changes.push(`hook ${event}: already installed (up to date)`);
    }
  }

  if (!dry) writeSettingsAtomic(settingsPath, settings);

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
    const { settings, unparseable } = loadSettingsForWrite(settingsPath);
    if (unparseable) {
      // Never rewrite an unparseable file as `{}` (MCP-F2): that silently deleted the user's
      // entire config with no backup. Refuse; the belay lines can be removed by hand.
      console.error(
        `belay uninstall: ${settingsPath} is not a valid JSON object — refusing to overwrite it (that would destroy your config).\n` +
          'Remove belay\'s hook lines (commands containing "belay.mjs") by hand.'
      );
      process.exitCode = 1;
      return;
    }
    copyFileSync(settingsPath, settingsPath + '.belay-bak'); // back up before touching it (uninstall had none)
    if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
      for (const event of Object.keys(settings.hooks)) {
        if (!Array.isArray(settings.hooks[event])) continue;
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter((m) => !(m?.hooks ?? []).some((h) => owned(h?.command)));
        if (settings.hooks[event].length !== before) changes.push(`hook ${event}: removed`);
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    writeSettingsAtomic(settingsPath, settings);
  }

  changes.push(unregisterMcp(argv));

  console.log(`belay uninstall ← ${dir}`);
  for (const c of changes.length ? changes : ['nothing to remove']) console.log('  - ' + c);
  console.log('\nOnly belay entries were removed; everything else in settings.json is untouched.\nLocal data in ~/.belay was kept; delete it manually for a clean slate.');
}
