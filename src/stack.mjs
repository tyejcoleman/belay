import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readJSON, tokenroomDir } from './util.mjs';
import { keyokuHome } from './keyoku.mjs';
import { configDir, MARK } from './install.mjs';

// One place that answers "is the whole autonomous stack wired?" — tokenroom (resource
// awareness) + keyoku (goal convergence MCP) + belay (this Stop/PreToolUse loop). Both
// `belay bundle` and `belay doctor` render from these, so the two never drift. Every check
// is read-only and defensive (ADR-4): a missing/garbled input degrades to "not found",
// never a throw.

export const KEYOKU_RANGE = { min: [2, 7], maxExclusive: 3 }; // >=2.7 <3

export function parseVersion(v) {
  const m = typeof v === 'string' && v.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Where Claude Code's `.claude.json` lives. Overridable so a hermetic test can seed one:
 *  $CLAUDE_JSON, else $CLAUDE_CONFIG_DIR/.claude.json when present, else ~/.claude.json. */
export function claudeJsonPath() {
  if (process.env.CLAUDE_JSON) return process.env.CLAUDE_JSON;
  const cd = process.env.CLAUDE_CONFIG_DIR;
  if (cd) {
    const p = join(cd, '.claude.json');
    if (existsSync(p)) return p;
  }
  return join(homedir(), '.claude.json');
}

/** Every mcpServers entry across the top level and per-project blocks, as [name, spec]. */
function allMcpServers() {
  const cj = readJSON(claudeJsonPath());
  const servers = [];
  if (cj && typeof cj === 'object') {
    if (cj.mcpServers && typeof cj.mcpServers === 'object') servers.push(...Object.entries(cj.mcpServers));
    if (cj.projects && typeof cj.projects === 'object') {
      for (const p of Object.values(cj.projects)) {
        if (p && typeof p === 'object' && p.mcpServers && typeof p.mcpServers === 'object') servers.push(...Object.entries(p.mcpServers));
      }
    }
  }
  return servers;
}

/** keyoku's package.json: $KEYOKU_INSTALL, else walk up from the MCP registration script. */
export function findKeyokuVersion() {
  const candidates = [];
  if (process.env.KEYOKU_INSTALL) candidates.push(process.env.KEYOKU_INSTALL);
  for (const [name, s] of allMcpServers()) {
    if (!/keyoku/i.test(name)) continue;
    const args = Array.isArray(s?.args) ? s.args : [];
    for (const a of [s?.command, ...args]) {
      if (typeof a === 'string' && a.endsWith('.js')) candidates.push(dirname(a));
    }
  }
  for (let base of candidates) {
    for (let i = 0; i < 5 && base && base !== '/'; i++, base = dirname(base)) {
      const pkg = readJSON(join(base, 'package.json'));
      if (pkg && typeof pkg === 'object' && /keyoku/i.test(String(pkg.name ?? ''))) {
        return { version: typeof pkg.version === 'string' ? pkg.version : null, path: join(base, 'package.json') };
      }
    }
  }
  return null;
}

/** { registered, version, inRange, path } — keyoku MCP registration + version-pin check. */
export function keyokuStatus() {
  const registered = allMcpServers().some(([name]) => /keyoku/i.test(name));
  const kv = findKeyokuVersion();
  const v = kv && parseVersion(kv.version);
  const inRange = !!v && v[0] < KEYOKU_RANGE.maxExclusive && (v[0] > KEYOKU_RANGE.min[0] || (v[0] === KEYOKU_RANGE.min[0] && v[1] >= KEYOKU_RANGE.min[1]));
  return { registered, version: kv?.version ?? null, inRange, path: kv?.path ?? null, home: keyokuHome(), homeExists: existsSync(keyokuHome()) };
}

/** Resolve how to invoke tokenroom's installer: --tokenroom <path> / $TOKENROOM_BIN (a file),
 *  else `tokenroom` on PATH. Returns { resolvable, exec, args, label } — never throws. */
export function resolveTokenroom(argv = []) {
  const i = argv.indexOf('--tokenroom');
  const explicit = i >= 0 && argv[i + 1] ? argv[i + 1] : process.env.TOKENROOM_BIN || null;
  if (explicit) {
    // An explicitly named path wins; if it does not exist, say so — never silently fall
    // back to PATH (that would mask a typo).
    if (existsSync(explicit)) {
      if (/\.(mjs|js|cjs)$/.test(explicit)) return { resolvable: true, exec: process.execPath, args: [explicit], label: explicit };
      return { resolvable: true, exec: explicit, args: [], label: explicit };
    }
    return { resolvable: false, exec: null, args: [], label: null, badPath: explicit };
  }
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(whichCmd, ['tokenroom'], { encoding: 'utf8' });
    const line = (r.stdout || '').split('\n').map((s) => s.trim()).find(Boolean);
    if (r.status === 0 && line) return { resolvable: true, exec: 'tokenroom', args: [], label: `tokenroom on PATH (${line})` };
  } catch {
    /* which unavailable → treat as not resolvable */
  }
  return { resolvable: false, exec: null, args: [], label: null };
}

/** True if tokenroom left its mark in settings.json (statusLine or any hook command). */
export function tokenroomInstalled(dir) {
  const s = readJSON(join(dir, 'settings.json'));
  if (!s || typeof s !== 'object') return false;
  const hit = (c) => typeof c === 'string' && /tokenroom/i.test(c);
  if (hit(s.statusLine?.command)) return true;
  if (s.hooks && typeof s.hooks === 'object') {
    for (const arr of Object.values(s.hooks)) {
      if (Array.isArray(arr) && arr.some((m) => (m?.hooks ?? []).some((h) => hit(h?.command)))) return true;
    }
  }
  return false;
}

/** { stop, preToolUse } — are belay's own hooks registered in settings.json? */
export function belayHooksStatus(dir) {
  const s = readJSON(join(dir, 'settings.json'));
  const reg = (event) => {
    const entries = Array.isArray(s?.hooks?.[event]) ? s.hooks[event] : [];
    return entries.some((m) => (m?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.includes(MARK)));
  };
  return { stop: reg('Stop'), preToolUse: reg('PreToolUse') };
}

/** The whole-stack snapshot both `bundle` and `doctor` render from. */
export function stackHealth(argv = []) {
  const dir = configDir(argv);
  const tr = resolveTokenroom(argv);
  return {
    dir,
    tokenroom: {
      resolvable: tr.resolvable,
      label: tr.label,
      present: tr.resolvable || existsSync(tokenroomDir()) || tokenroomInstalled(dir),
      installed: tokenroomInstalled(dir),
    },
    keyoku: keyokuStatus(),
    belay: belayHooksStatus(dir),
  };
}

/** Compact one-health-view lines: `  [ok|warn|FAIL] …` (shared by doctor + bundle). */
export function renderStackHealth(h) {
  const lines = [];
  const L = (lvl, msg) => lines.push(`  [${lvl}] ${msg}`);

  const t = h.tokenroom;
  if (t.installed) L('ok', `tokenroom: installed (hooks/statusline present)${t.resolvable ? '' : ' — bin not on PATH, that is fine once installed'}`);
  else if (t.present) L('warn', `tokenroom: present but not installed here — run \`belay bundle\` (or \`tokenroom install\`)`);
  else L('warn', 'tokenroom: not found — budget will read UNKNOWN; install it, then `belay bundle` (see https://github.com/tyejcoleman/tokenroom)');

  const k = h.keyoku;
  if (!k.registered) L('warn', 'keyoku: MCP server NOT registered — belay has no goals to drive (register keyoku in ~/.claude.json)');
  else if (k.version == null) L('warn', 'keyoku: registered, but package.json not findable — version pin >=2.7 <3 unverified (set KEYOKU_INSTALL)');
  else if (!k.inRange) L('warn', `keyoku: registered, version ${k.version} OUTSIDE the pinned range >=2.7 <3 — re-verify the file-layout contract`);
  else L('ok', `keyoku: registered, version ${k.version} (in range >=2.7 <3)`);

  const b = h.belay;
  if (b.stop && b.preToolUse) L('ok', 'belay: Stop + PreToolUse hooks registered');
  else L('warn', `belay: hooks ${b.stop ? '' : 'Stop '}${b.preToolUse ? '' : 'PreToolUse '}NOT registered — run \`belay bundle\` (or \`belay install\`)`);

  return lines;
}
