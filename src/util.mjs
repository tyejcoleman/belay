import { mkdirSync, chmodSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Belay is a READER of two other tools' state and a writer only of its own tiny
// counter file. Every read here is defensive (tokenroom ADR-5 spirit, adopted as our
// ADR-4): absent, malformed, or torn input degrades to null — never to a throw that
// could surface as a hook error banner in the harness.

export const belayDir = () => process.env.BELAY_DIR || join(homedir(), '.belay');
export const tokenroomDir = () => process.env.TOKENROOM_DIR || join(homedir(), '.tokenroom');

/** Counter state may reveal what the user is working on — owner-only, like tokenroom. */
export const ensureDir = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* exotic FS without chmod — the mkdir mode already covered the created case */
  }
};

export function atomicWrite(path, text) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function atomicWriteJSON(path, obj) {
  atomicWrite(path, JSON.stringify(obj, null, 2));
}

export function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Percentages must be 0–100; anything else becomes null (tokenroom's epoch-leak lesson). */
export function clampPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return null;
  return v;
}

/** Epoch seconds from: epoch sec, epoch ms, or an ISO-8601 string (keyoku writes ISO). */
export function toEpochSec(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms / 1000);
  }
  return null;
}

// ── Sanitizers for model-visible reasons (ADR-7) ─────────────────────────────
// Sibling-goal-derived strings (criteria descriptions, slugs, tokenroom labels) flow into
// the Stop-hook block reason, which Claude Code feeds back as model-visible context. Treat
// them as untrusted: strip control chars/newlines, cap length (anti-injection + anti-flood).

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g; // C0 + DEL + C1 control chars (incl. newlines/CR/tab)

/** Free text → single-line, control-char-free, length-capped (default 120). */
export function sanitizeText(s, max = 120) {
  if (typeof s !== 'string' || !s) return '';
  let t = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

/** Identifier (slug / criterion id / profile label) → tame charset, length-capped. */
export function sanitizeSlug(s, max = 64) {
  if (typeof s !== 'string') return '';
  const t = s
    .replace(CONTROL, '')
    .replace(/[^\w.@/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return t || 'unknown';
}

/** Hard cap the whole reason string (belt-and-suspenders against context flooding). */
export function capReason(s, max = 2048) {
  return typeof s === 'string' && s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function fmtClock(sec) {
  if (!sec) return '?';
  const d = new Date(sec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function readStdin() {
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    // best-effort
  }
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
// ~/.belay/config.json — every field optional, every field validated. A bad
// config never changes behavior silently: the bad field falls back to its default
// and `belay doctor` reports the warning.

export const CONFIG_DEFAULTS = {
  max_continuations: 25, // per (session, goal): own runaway-loop budget on top of Claude Code's stop_hook_active guard
  budget_floor_pct: 3, // below this (and no fresh alt profile) quota-dead is the one legit stop
  spawn_floor_pct: 10, // below this (and no fresh alt profile) new Task/Agent/Workflow spawns route to the human
  thin_budget_pct: 15, // below this the block reason switches to descent wording
  stale_assess_min: 60, // observations older than this get one "run goal_assess first" block, then allow
  gate_enabled: true, // PreToolUse policy gate master switch
  ask_patterns: [], // extra [{pattern, class, note}] — tested against BOTH tool_name and Bash command
  allow_overrides: [], // [pattern] force-allow, matched before any ask class
};

export function toRegExp(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

export function validateConfig(raw) {
  const cfg = { ...CONFIG_DEFAULTS, ask_patterns: [], allow_overrides: [] };
  const warnings = [];
  if (raw == null) return { cfg, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { cfg, warnings: ['config.json is not a JSON object — using defaults'] };
  }
  for (const key of ['max_continuations', 'budget_floor_pct', 'spawn_floor_pct', 'thin_budget_pct', 'stale_assess_min']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0) cfg[key] = raw[key];
    else warnings.push(`config: ${key} must be a non-negative number — using default ${CONFIG_DEFAULTS[key]}`);
  }
  if (raw.gate_enabled !== undefined) {
    if (typeof raw.gate_enabled === 'boolean') cfg.gate_enabled = raw.gate_enabled;
    else warnings.push('config: gate_enabled must be a boolean — using default true');
  }
  if (raw.ask_patterns !== undefined) {
    if (Array.isArray(raw.ask_patterns)) {
      for (const p of raw.ask_patterns) {
        if (p && typeof p === 'object' && toRegExp(p.pattern)) {
          cfg.ask_patterns.push({ pattern: p.pattern, class: typeof p.class === 'string' ? p.class : 'custom', note: typeof p.note === 'string' ? p.note : null });
        } else {
          warnings.push(`config: ask_patterns entry ${JSON.stringify(p)} is not {pattern: <valid regex>, class?, note?} — skipped`);
        }
      }
    } else warnings.push('config: ask_patterns must be an array — ignored');
  }
  if (raw.allow_overrides !== undefined) {
    if (Array.isArray(raw.allow_overrides)) {
      for (const p of raw.allow_overrides) {
        if (toRegExp(p)) cfg.allow_overrides.push(p);
        else warnings.push(`config: allow_overrides entry ${JSON.stringify(p)} is not a valid regex string — skipped`);
      }
    } else warnings.push('config: allow_overrides must be an array of regex strings — ignored');
  }
  return { cfg, warnings };
}

export function readConfig() {
  return validateConfig(readJSON(join(belayDir(), 'config.json')));
}
