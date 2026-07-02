import { resolve } from 'node:path';
import { readStdin, readConfig, toRegExp } from './util.mjs';
import { readKeyoku } from './keyoku.mjs';
import { readBudget } from './budget.mjs';

// PreToolUse policy gate (autonomy x budget x action-class). ONLY active while a
// scope-matched focused AUTONOMOUS ACTIVE goal exists — belay never polices normal
// interactive use (ADR-4). Irreversible/external actions route to the HUMAN via
// permissionDecision "ask" (ADR-3: the human decides; belay only makes sure the
// question gets asked). Everything unmatched exits silently.

export const SPAWN_TOOLS = ['Task', 'Agent', 'Workflow'];

// git/gh/npm mutations that must route to the human. Classified by TOKENS (not a regex
// anchored to "binary immediately followed by subcommand") so a GLOBAL OPTION can't smuggle
// the subcommand past the check: `git -C DIR push`, `git --git-dir=x push`,
// `gh -R owner/repo pr merge`, `env FOO=bar git push` all match now.
const GIT_GLOBAL_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
const GH_GLOBAL_ARG = new Set(['-R', '--repo']);
const GH_MUTATION_SUB = new Set(['pr', 'release', 'repo']);
const GH_MUTATION_ACTION = new Set(['create', 'merge', 'edit', 'delete']);

/** First non-option token at/after startIdx, skipping global options — and the SEPARATE
 *  argument of any option listed in takesArg. Returns { sub, idx } (idx = -1 if none). */
function nextSubcommand(tok, startIdx, takesArg) {
  let i = startIdx;
  while (i < tok.length) {
    const t = tok[i];
    if (t.startsWith('-')) {
      const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
      if (!t.includes('=') && takesArg.has(name)) i++; // consume its separate argument
      i++;
      continue;
    }
    return { sub: t, idx: i };
  }
  return { sub: null, idx: -1 };
}

/** git push / npm publish / gh (pr|release|repo) (create|merge|edit|delete), or null. */
function classifyVcs(command) {
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const tok = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tok.length && (tok[i] === 'sudo' || tok[i] === 'command' || tok[i] === 'env' || tok[i] === 'nice' || /^[\w.]+=/.test(tok[i]))) i++;
    const bin = (tok[i] || '').split('/').pop();
    if (bin === 'git') {
      if (nextSubcommand(tok, i + 1, GIT_GLOBAL_ARG).sub === 'push') return 'git push';
    } else if (bin === 'npm') {
      if (nextSubcommand(tok, i + 1, new Set()).sub === 'publish') return 'npm publish';
    } else if (bin === 'gh') {
      const first = nextSubcommand(tok, i + 1, GH_GLOBAL_ARG);
      if (GH_MUTATION_SUB.has(first.sub)) {
        const action = nextSubcommand(tok, first.idx + 1, GH_GLOBAL_ARG);
        if (GH_MUTATION_ACTION.has(action.sub)) return 'gh mutation';
      }
    }
  }
  return null;
}

// External sends via MCP tools (Slack messages, Gmail drafts/sends, generic publish).
// Scoped to mcp__ tools on purpose: built-in harness tools (e.g. subagent SendMessage)
// are in-session coordination, not external side effects.
const TOOLNAME_ASK = /^mcp__.*(send|publish|add_message|post_message|create_draft)/i;

// Locate every rm invocation regardless of shell wrapper or quoting: after a command
// boundary / whitespace / quote / '(' / '=' , an optional path prefix (/bin/rm), then rm.
// The captured tail runs to the next boundary (newline ; | & or backtick).
const RM_SCAN = /(?:^|[\s;|&`'"(=])(?:[\w./-]*\/)?rm\b([^\n;|&`]*)/g;

/**
 * rm -rf whose resolved target escapes the session cwd. Conservative + WRAPPER-AWARE
 * (ADR-3: ask, not deny — over-asking is safe): a recursive+force rm is caught even behind
 * `sh -c '…'`, `env VAR=x rm`, backticks, `$(…)`, `xargs rm`, an absolute `/bin/rm`, or
 * inside quotes — cases the plain token walk missed. Targets we cannot prove are inside cwd
 * — unexpanded `$VAR` / `$(…)` / backticks, or absent entirely (stdin/xargs/redirect) — are
 * treated as OUTSIDE and routed to the human.
 */
export function rmrfOutsideCwd(command, cwd) {
  if (typeof command !== 'string' || !command) return false;
  const base = typeof cwd === 'string' && cwd ? cwd.replace(/\/+$/, '') : null;
  RM_SCAN.lastIndex = 0;
  let m;
  while ((m = RM_SCAN.exec(command))) {
    const toks = m[1].replace(/['"]/g, ' ').split(/\s+/).filter(Boolean);
    const flags = toks.filter((t) => t.startsWith('-'));
    const short = flags.filter((f) => /^-[a-zA-Z]+$/.test(f)).join('');
    const recursive = /[rR]/.test(short) || flags.includes('--recursive');
    const force = short.includes('f') || flags.includes('--force');
    if (!(recursive && force)) continue;
    // xargs feeds rm's targets from stdin — the args we can see are not the real targets.
    const preRun = command.slice(0, m.index).split(/[\n;|&`]/).pop() || '';
    if (/\bxargs\b/.test(preRun)) return true;
    const paths = toks.filter((t) => !t.startsWith('-'));
    if (paths.length === 0) return true; // no explicit target (stdin/xargs/redirect) → can't prove inside
    for (const t of paths) {
      if (/[$`]/.test(t)) return true; // unexpanded var/subshell target → treat as outside
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
    const vcs = classifyVcs(command);
    if (vcs) return { class: vcs, note: null };
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
      reason: `[belay] '${hit.class}' action under autonomous goal — requires human approval (goal constraint policy)${hit.note ? ` — ${hit.note}` : ''}`,
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
        reason: `[belay] budget descent: no new subagents below ${cfg.spawn_floor_pct}% — do the work inline in small steps`,
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
