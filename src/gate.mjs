import { resolve } from 'node:path';
import { readStdin, readConfig, toRegExp } from './util.mjs';
import { readKeyoku } from './keyoku.mjs';
import { readBudget } from './budget.mjs';

// PreToolUse policy gate (autonomy x budget x action-class). ONLY active while a
// scope-matched focused AUTONOMOUS ACTIVE goal exists — conductor never polices normal
// interactive use (ADR-4). Irreversible/external actions route to the HUMAN via
// permissionDecision "ask" (ADR-3: the human decides; conductor only makes sure the
// question gets asked). Everything unmatched exits silently.

export const SPAWN_TOOLS = ['Task', 'Agent', 'Workflow'];

const DEFAULT_COMMAND_ASKS = [
  { re: /\bgit\s+push\b/, cls: 'git push' },
  { re: /\bnpm\s+publish\b/, cls: 'npm publish' },
  { re: /\bgh\s+(pr|release|repo)\s+(create|merge|edit|delete)\b/, cls: 'gh mutation' },
];

// External sends via MCP tools (Slack messages, Gmail drafts/sends, generic publish).
// Scoped to mcp__ tools on purpose: built-in harness tools (e.g. subagent SendMessage)
// are in-session coordination, not external side effects.
const TOOLNAME_ASK = /^mcp__.*(send|publish|add_message|post_message|create_draft)/i;

/** rm -rf whose resolved target escapes the session cwd (or is clearly absolute/home). */
export function rmrfOutsideCwd(command, cwd) {
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const tok = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (tok[i] === 'sudo' || tok[i] === 'env' || tok[i] === 'command') i++;
    if (!(tok[i] === 'rm' || (tok[i] ?? '').endsWith('/rm'))) continue;
    const args = tok.slice(i + 1);
    const flags = args.filter((t) => t.startsWith('-'));
    const short = flags.filter((f) => /^-[a-zA-Z]+$/.test(f)).join('');
    const recursive = /[rR]/.test(short) || flags.includes('--recursive');
    const force = short.includes('f') || flags.includes('--force');
    if (!(recursive && force)) continue;
    const base = typeof cwd === 'string' && cwd ? cwd.replace(/\/+$/, '') : null;
    for (const raw of args.filter((t) => !t.startsWith('-'))) {
      const t = raw.replace(/^['"]|['"]$/g, '');
      if (!t) continue;
      if (t === '/' || t.startsWith('~')) return true;
      if (!base) {
        // unknown cwd: judge only what is provably outside a project dir
        if (t.startsWith('/') || t.includes('..')) return true;
        continue;
      }
      const abs = t.startsWith('/') ? t : resolve(base, t);
      if (!(abs === base || abs.startsWith(base + '/'))) return true;
    }
  }
  return false;
}

/** curl/wget performing a POST/PUT (or body upload) to anything that isn't localhost. */
export function externalNetworkWrite(command) {
  if (!/\b(curl|wget)\b/.test(command)) return false;
  const writey =
    /(\s-X\s*['"]?(POST|PUT)\b|--request[=\s]+['"]?(POST|PUT)\b|--method[=\s]+['"]?(POST|PUT)\b|\s(-d|--data(-\w+)?|--json|--form|-F|--upload-file|-T|--post-data|--post-file|--body-data|--body-file)([=\s]|$))/i;
  if (!writey.test(command)) return false;
  const urls = command.match(/https?:\/\/[^\s"']+/gi) || [];
  const local = /^https?:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)([:/?#]|$)/i;
  if (urls.length > 0 && urls.every((u) => local.test(u))) return false;
  return true; // includes "no parseable URL": default deny→ask for this class
}

/** First matching irreversible/external class, or null. Config ask_patterns are tested
 *  against BOTH the tool name and the Bash command string. */
export function classify(name, command, cwd, cfg) {
  if (command) {
    for (const d of DEFAULT_COMMAND_ASKS) if (d.re.test(command)) return { class: d.cls, note: null };
    if (rmrfOutsideCwd(command, cwd)) return { class: 'rm -rf outside cwd', note: null };
    if (externalNetworkWrite(command)) return { class: 'network write', note: null };
  }
  if (name && TOOLNAME_ASK.test(name)) return { class: 'external send/publish', note: null };
  for (const p of cfg.ask_patterns) {
    const re = toRegExp(p.pattern);
    if (!re) continue;
    if ((command && re.test(command)) || (name && re.test(name))) return { class: p.class || 'custom', note: p.note || null };
  }
  return null;
}

/**
 * Pure decision: null = exit silently (allow), or { decision: 'ask', reason }.
 * `budget` may be null when the caller skipped the read (non-spawn tools).
 */
export function decideGate(p, k, budget, cfg) {
  if (!cfg.gate_enabled) return null;
  if (!k.present || k.paused || !k.focus || !k.matched || !k.goal) return null;
  if (k.goal.status !== 'active' || k.goal.autonomy !== 'autonomous') return null;

  const name = typeof p.tool_name === 'string' ? p.tool_name : '';
  const command = typeof p.tool_input?.command === 'string' ? p.tool_input.command : '';

  for (const pat of cfg.allow_overrides) {
    const re = toRegExp(pat);
    if (re && ((name && re.test(name)) || (command && re.test(command)))) return null;
  }

  const hit = classify(name, command, p.cwd, cfg);
  if (hit) {
    return {
      decision: 'ask',
      reason: `[conductor] '${hit.class}' action under autonomous goal — requires human approval (goal constraint policy)${hit.note ? ` — ${hit.note}` : ''}`,
    };
  }

  // Expensive spawns under thin budget: a subagent is an INDIVISIBLE bet — it can't be
  // checkpointed mid-flight. Conservative on stale data: a stale LOW last-known reading
  // still gates (we don't assume the window refilled); tokenroom absent gates nothing.
  if (SPAWN_TOOLS.includes(name) && budget) {
    const left = budget.known ? budget.left_pct : budget.stale ? budget.last_known_left : null;
    if (left != null && left < cfg.spawn_floor_pct && !budget.alt) {
      return {
        decision: 'ask',
        reason: `[conductor] budget descent: no new subagents below ${cfg.spawn_floor_pct}% — do the work inline in small steps`,
      };
    }
  }
  return null;
}

export async function hookPreToolUse() {
  const p = await readStdin();
  try {
    const { cfg } = readConfig();
    if (!cfg.gate_enabled) return;
    const k = readKeyoku({ sessionId: p.session_id, cwd: p.cwd });
    if (!k.present || k.paused || !k.focus || !k.matched || !k.goal) return;
    const budget = SPAWN_TOOLS.includes(p.tool_name) ? readBudget(p.session_id) : null;
    const d = decideGate(p, k, budget, cfg);
    if (!d) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: d.decision,
          permissionDecisionReason: d.reason,
        },
      })
    );
  } catch {
    // ANY error = silent exit 0 (allow): the gate must never wedge a session
  }
}
