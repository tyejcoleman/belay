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

/** Hard cap the whole reason string in UTF-8 BYTES (belt-and-suspenders against context
 *  flooding). Refute L3-1: the documented budgets (1.5KB additionalContext, ~2KB reason)
 *  are byte budgets, but the old cap counted UTF-16 code units — 200 CJK code units are
 *  600-800 bytes, so multibyte file-controlled input sailed past the cap untouched.
 *  Slices on a code-point boundary and reserves 3 bytes for the '…' marker, so the
 *  result is always <= max bytes. */
export function capReason(s, max = 2048) {
  if (typeof s !== 'string' || Buffer.byteLength(s, 'utf8') <= max) return s;
  let t = Buffer.from(s, 'utf8')
    .subarray(0, Math.max(0, max - 3))
    .toString('utf8');
  t = t.replace(/�+$/, ''); // a split trailing code point decodes as replacement chars — drop them
  return t + '…';
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
  thrash_threshold: 3, // identical-unmet blocks before the Stop reason switches to "change strategy" guidance (ADR-21)
  thrash_release: 8, // identical-unmet blocks before belay escalates then RELEASES a stalled loop early (adaptive budget, ADR-21) — well under max_continuations
  milestone_iterations: 200, // a goal DECLARING a horizon >= this is a multi-session MILESTONE (coarse criteria flip rarely) — early thrash-release is suppressed for it, leaving max_continuations as the sole per-session bound (ADR-23, B1)
  gate_enabled: true, // PreToolUse policy gate master switch
  gate_mode: 'ask', // 'ask' routes irreversible classes to the human live; 'defer' denies-with-guidance and queues them for one batched review at convergence (ADR-16)
  ask_patterns: [], // extra [{pattern, class, note}] — tested against BOTH tool_name and Bash command
  allow_overrides: [], // [pattern] force-allow, matched before any ask class
  danger_binaries: {}, // {binary: [subcommands] | ['*']} — extends the built-in danger table (ADR-18); merged over gate.mjs DEFAULT_DANGER_BINARIES
  slm_enabled: false, // stage-2 learned adjudicator (ADR-17): opt-in; SOFT classes only; fail-safe = stage-1
  slm_catch: false, // catch-mode (ADR-17 ext): also consult the daemon on a stage-1 MISS to gate novel dangerous commands the denylist can't express (add-friction only; requires slm_enabled)
  slm_url: 'http://127.0.0.1:8642/adjudicate', // local adjudicator daemon endpoint (CGS GATE-ADJUDICATOR-PLAN §3)
  slm_timeout_ms: 1500, // hard AbortController cap on the stage-2 POST; on breach the stage-1 decision stands
  slm_min_confidence: 0.9, // a SOFT-class 'allow' verdict is accepted only at/above this confidence (calibrated τ)
  proposals_enabled: true, // master switch for the proposal scan + SessionStart surfacing (DESIGN.md §3.5)
  proposal_max_surfaced: 3, // proposals per SessionStart injection
  stale_converged_days: 7, // converged goals older than this become re-assess proposals
  keyoku_call_timeout_ms: 15000, // per keyoku-child JSON-RPC call (ADR-10)
  retro_auto_push: false, // on disarm, also file the loop retro into keyoku's knowledge store (opt-in; spawns keyoku)
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
  const cfg = { ...CONFIG_DEFAULTS, ask_patterns: [], allow_overrides: [], danger_binaries: {} };
  const warnings = [];
  if (raw == null) return { cfg, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { cfg, warnings: ['config.json is not a JSON object — using defaults'] };
  }
  for (const key of ['max_continuations', 'budget_floor_pct', 'spawn_floor_pct', 'thin_budget_pct', 'stale_assess_min', 'thrash_threshold', 'thrash_release', 'milestone_iterations', 'proposal_max_surfaced', 'stale_converged_days', 'keyoku_call_timeout_ms', 'slm_timeout_ms']) {
    if (raw[key] === undefined) continue;
    // keyoku_call_timeout_ms needs a sane floor (refute L2-5): 0 passed the >=0 check and
    // made EVERY keyoku RPC time out instantly (setTimeout(...,0) fires before spawn+SDK
    // startup ≈0.5-1s can possibly answer), deterministically breaking the write path
    // while doctor showed a valid config. Below 1000ms falls back like any bad field.
    // slm_timeout_ms gets the same treatment at 100ms: an instant-abort timeout would
    // silently disable stage 2 forever while doctor showed a valid config.
    const min = key === 'keyoku_call_timeout_ms' ? 1000 : key === 'slm_timeout_ms' ? 100 : key === 'thrash_threshold' || key === 'thrash_release' ? 2 : 0;
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= min) cfg[key] = raw[key];
    else warnings.push(`config: ${key} must be a ${min > 0 ? `number >= ${min}` : 'non-negative number'} — using default ${CONFIG_DEFAULTS[key]}`);
  }
  for (const key of ['gate_enabled', 'proposals_enabled', 'slm_enabled', 'slm_catch', 'retro_auto_push']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'boolean') cfg[key] = raw[key];
    else warnings.push(`config: ${key} must be a boolean — using default ${CONFIG_DEFAULTS[key]}`);
  }
  if (raw.slm_url !== undefined) {
    let ok = false;
    if (typeof raw.slm_url === 'string' && raw.slm_url) {
      try {
        const u = new URL(raw.slm_url);
        ok = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        /* not a URL — falls back below */
      }
    }
    if (ok) cfg.slm_url = raw.slm_url;
    else warnings.push(`config: slm_url must be an http(s) URL — using default ${CONFIG_DEFAULTS.slm_url}`);
  }
  if (raw.slm_min_confidence !== undefined) {
    if (typeof raw.slm_min_confidence === 'number' && Number.isFinite(raw.slm_min_confidence) && raw.slm_min_confidence >= 0 && raw.slm_min_confidence <= 1) cfg.slm_min_confidence = raw.slm_min_confidence;
    else warnings.push(`config: slm_min_confidence must be a number between 0 and 1 — using default ${CONFIG_DEFAULTS.slm_min_confidence}`);
  }
  if (raw.gate_mode !== undefined) {
    if (raw.gate_mode === 'ask' || raw.gate_mode === 'defer') cfg.gate_mode = raw.gate_mode;
    else warnings.push(`config: gate_mode must be 'ask' or 'defer' — using default '${CONFIG_DEFAULTS.gate_mode}'`);
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
  if (raw.danger_binaries !== undefined) {
    if (raw.danger_binaries && typeof raw.danger_binaries === 'object' && !Array.isArray(raw.danger_binaries)) {
      for (const [bin, subs] of Object.entries(raw.danger_binaries)) {
        if (typeof bin === 'string' && bin && Array.isArray(subs)) {
          const clean = subs.filter((s) => typeof s === 'string' && s);
          if (clean.length) cfg.danger_binaries[bin.toLowerCase()] = clean;
          else warnings.push(`config: danger_binaries['${bin}'] must be a non-empty array of subcommand strings (or ['*']) — skipped`);
        } else warnings.push(`config: danger_binaries['${bin}'] must be an array of subcommand strings (or ['*']) — skipped`);
      }
    } else warnings.push('config: danger_binaries must be an object of {binary: [subcommands]} — ignored');
  }
  return { cfg, warnings };
}

export function readConfig() {
  return validateConfig(readJSON(join(belayDir(), 'config.json')));
}
