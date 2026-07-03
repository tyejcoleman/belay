import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readStdin, readConfig, toRegExp, capReason, sanitizeText } from './util.mjs';
import { readKeyoku } from './keyoku.mjs';
import { readBudget } from './budget.mjs';
import { appendPending } from './pending.mjs';

// PreToolUse policy gate (autonomy x budget x action-class). ONLY active while a
// scope-matched focused AUTONOMOUS ACTIVE goal exists — belay never polices normal
// interactive use (ADR-4). Irreversible/external actions route to the HUMAN via
// permissionDecision "ask" (ADR-3: the human decides; belay only makes sure the
// question gets asked) — or, under gate_mode 'defer' (ADR-16), are DENIED with guidance
// and queued for one batched human review at convergence (strictly safer than ask; the
// arrest is never weakened). Everything unmatched exits silently.
//
// Stage 2 (ADR-17, opt-in via slm_enabled): after a SOFT-class stage-1 hit, the hook —
// never the pure decideGate — consults a local learned adjudicator daemon (the CGS
// GATE-ADJUDICATOR-PLAN §3 contract) that may REFINE the decision: a well-formed,
// non-abstaining, high-confidence 'allow' lifts a provable over-ask (mktemp rm -rf,
// localhost-ambiguous curl). HARD classes are never sent to the daemon and never
// unlockable; on ANY failure (daemon absent, timeout, non-200, bad JSON) the stage-1
// decision stands byte-identically.

export const SPAWN_TOOLS = ['Task', 'Agent', 'Workflow'];

// ── ADR-17 class split — enforced in code, never by the model ─────────────────────────
// HARD: irreversible/externally-visible actions the learned adjudicator can NEVER unlock.
// The daemon is not even consulted for these (pointless + latency): stage 1 is final.
export const HARD_CLASSES = new Set(['git push', 'npm publish', 'gh mutation', 'external send/publish']);
// SOFT: classes where stage 1 provably over-asks (unexpanded-$VAR rm -rf targets, curl
// pipelines with no parseable URL) and a calibrated verdict may refine. SOFT is defined
// as NOT-HARD: these two built-ins plus every config ask_patterns class.
export const SOFT_CLASSES = new Set(['rm -rf outside cwd', 'network write']);

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

/** bypassPermissions sessions auto-resolve "ask" — the action runs with no prompt ever
 *  shown (observed live 2026-07-02: the gate emitted ask, `git push --dry-run` executed
 *  anyway). ADR-3's contract is "the question gets asked"; when the harness cannot ask,
 *  the only way to keep the human in the loop is deny-with-instructions ("deny" IS
 *  enforced under bypass; "ask" is not). ADR-13. Note the instructions say DISARM, not
 *  pause: pausing releases only the rope, never the arrest (ADR-12). */
function escalateForBypass(p, d) {
  if (!d || d.decision !== 'ask' || p.permission_mode !== 'bypassPermissions') return d;
  return {
    decision: 'deny',
    reason: capReason(
      `${d.reason}. This session runs bypassPermissions, where an approval prompt cannot be shown — denied instead of silently allowed (ADR-13). To proceed: run this action from a session without bypassPermissions, or fully stand the loop down first (belay_loop_disarm / keyoku goal_unfocus — pause is NOT enough, it keeps the arrest) and retry.`
    ),
  };
}

/**
 * Pure decision: null = exit silently (allow), or { decision: 'ask'|'deny', reason }
 * ('ask' escalates to 'deny' under bypassPermissions — see escalateForBypass).
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
    // gate_mode 'defer' (ADR-16): deny-with-guidance instead of ask, so an unattended
    // loop is never stalled on a prompt nobody will answer — the action is queued (by the
    // hook wrapper, never here: this function stays pure) for ONE batched human review at
    // convergence. Deny is strictly SAFER than ask, so no escalateForBypass pass is
    // needed: under bypassPermissions this is already the ADR-13 end state. The `defer`
    // field is hook-internal routing metadata — it never reaches stdout.
    if (cfg.gate_mode === 'defer') {
      // MCP-tool hits carry no command — capture the capped tool_input JSON instead, so
      // the batched review shows WHAT would have been sent, not just which tool.
      const detail = command || (p.tool_input ? JSON.stringify(p.tool_input) : '');
      return {
        decision: 'deny',
        reason: capReason(`[belay] '${sanitizeText(hit.class, 40)}' action deferred under autonomous goal — queued for batched human approval at convergence; continue with sandbox-safe work (gate_mode: defer)`),
        defer: { class: hit.class, tool_name: name, command: (detail || '').slice(0, 500) },
        hit: { class: hit.class },
      };
    }
    // class/note can originate from config ask_patterns (a file), so they never land raw
    // in a model-visible reason (ADR-7).
    // `hit` is hook-internal routing metadata like `defer` — it never reaches stdout; the
    // stage-2 adjudicator branch keys on it (ADR-17). escalateForBypass intentionally
    // rebuilds the decision without it: a bypass-escalated deny is never SLM-refinable.
    return escalateForBypass(p, {
      decision: 'ask',
      reason: capReason(`[belay] '${sanitizeText(hit.class, 40)}' action under autonomous goal — requires human approval (goal constraint policy)${hit.note ? ` — ${sanitizeText(hit.note, 120)}` : ''}`),
      hit: { class: hit.class },
    });
  }

  // Expensive spawns under thin budget: a subagent is an INDIVISIBLE bet — it can't be
  // checkpointed mid-flight. Conservative on stale data: a stale LOW last-known reading
  // still gates (we don't assume the window refilled); tokenroom absent gates nothing.
  if (SPAWN_TOOLS.includes(name) && budget) {
    const left = budget.known ? budget.left_pct : budget.stale ? budget.last_known_left : null;
    if (left != null && left < cfg.spawn_floor_pct && !budget.alt) {
      return escalateForBypass(p, {
        decision: 'ask',
        reason: `[belay] budget descent: no new subagents below ${cfg.spawn_floor_pct}% — do the work inline in small steps`,
      });
    }
  }
  return null;
}

// ── Stage 2: learned adjudicator (ADR-17) ──────────────────────────────────────────────

/** Structural check on the daemon's §3 response. The daemon is UNTRUSTED input: anything
 *  that is not exactly {verdict: allow|defer|ask, confidence: finite 0..1, abstain: bool}
 *  is malformed and merges as "stage 1 stands". */
function wellFormedVerdict(r) {
  return (
    r !== null &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    (r.verdict === 'allow' || r.verdict === 'defer' || r.verdict === 'ask') &&
    typeof r.confidence === 'number' &&
    Number.isFinite(r.confidence) &&
    r.confidence >= 0 &&
    r.confidence <= 1 &&
    typeof r.abstain === 'boolean'
  );
}

/**
 * Pure merge of the stage-1 decision with the (untrusted) SLM response — refine-only,
 * fail-safe-first (ADR-17). Returns null (allow, silent) or a decision object; every
 * degrade path returns `stage1Decision` ITSELF, so the fallback is byte-identical.
 *
 * - HARD class (or unclassifiable): stage-1 decision unchanged, ALWAYS — a well-formed
 *   rationale may ride along for the human (sanitized + capped, ADR-7), never a changed
 *   decision. (The hook never consults the daemon for HARD classes; this branch is
 *   defense-in-depth for direct callers.)
 * - SOFT class: 'allow' is accepted ONLY when the response is well-formed AND
 *   abstain === false AND confidence >= cfg.slm_min_confidence. 'defer' is accepted only
 *   when gate_mode is 'defer' — where the stage-1 decision already IS the ADR-16
 *   defer-queue deny, so accepting it returns that same decision (queue entry included);
 *   outside defer mode it degrades to stage-1. Everything else (malformed, abstain,
 *   low confidence, 'ask') → stage-1.
 */
export function mergeVerdict(stage1Hit, stage1Decision, slmResponse, cfg) {
  const cls = stage1Hit && typeof stage1Hit.class === 'string' ? stage1Hit.class : '';
  const ok = wellFormedVerdict(slmResponse);
  if (!cls || HARD_CLASSES.has(cls)) {
    if (ok && stage1Decision && typeof slmResponse.rationale === 'string' && slmResponse.rationale) {
      return { ...stage1Decision, reason: capReason(`${stage1Decision.reason} [slm: ${sanitizeText(slmResponse.rationale, 200)}]`) };
    }
    return stage1Decision;
  }
  if (!ok || slmResponse.abstain !== false) return stage1Decision;
  if (slmResponse.verdict === 'allow' && slmResponse.confidence >= cfg.slm_min_confidence) return null;
  if (slmResponse.verdict === 'defer' && cfg.gate_mode === 'defer') return stage1Decision; // the ADR-16 defer deny (+queue) IS the accepted outcome
  return stage1Decision; // 'ask', 'defer' outside defer mode, low-confidence 'allow'
}

/** POST the §3 request to the adjudicator daemon. Resolves the parsed response object,
 *  or null on ANY failure — timeout (AbortController hard cap), connection refused,
 *  non-200, oversized body, bad JSON. NEVER rejects and never throws: null means
 *  "stage 1 stands" (ADR-17 fail-safe). */
function adjudicate(url, body, timeoutMs) {
  return new Promise((resolvePromise) => {
    let timer = null;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(v);
    };
    try {
      const u = new URL(url);
      const ac = new AbortController();
      // Hard timeout: resolve null immediately AND abort the socket — the hook never
      // waits past slm_timeout_ms no matter what the daemon does.
      timer = setTimeout(() => {
        done(null);
        ac.abort();
      }, timeoutMs);
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
          if (raw.length > 64 * 1024) {
            done(null); // a verdict is ~200 bytes; a flooding daemon is malformed input
            ac.abort();
          }
        });
        res.on('error', () => done(null));
        res.on('end', () => {
          try {
            const o = JSON.parse(raw);
            done(o && typeof o === 'object' && !Array.isArray(o) ? o : null);
          } catch {
            done(null);
          }
        });
      });
      req.on('error', () => done(null));
      req.end(JSON.stringify(body));
    } catch {
      done(null);
    }
  });
}

export async function hookPreToolUse() {
  const p = await readStdin();
  try {
    const { cfg } = readConfig();
    if (!cfg.gate_enabled) return;
    const k = readKeyoku({ sessionId: p.session_id, cwd: p.cwd });
    if (!k.present || k.paused || !k.focus || !k.matched || !k.goal) return;
    const budget = SPAWN_TOOLS.includes(p.tool_name) ? readBudget(p.session_id) : null;
    let d = decideGate(p, k, budget, cfg);
    if (!d) return;
    // Stage 2 (ADR-17): consult the learned adjudicator ONLY for a SOFT-class hit with
    // slm_enabled — never for HARD classes (not unlockable, so the call is pure latency),
    // never for the spawn-budget ask (no `hit`), and never under bypassPermissions (the
    // one mode where no prompt of any kind reaches a human, the ADR-13 deny stays final).
    // decideGate itself stays pure: the network call lives here, in the hook, only.
    if (cfg.slm_enabled && d.hit && !HARD_CLASSES.has(d.hit.class) && p.permission_mode !== 'bypassPermissions') {
      const command = typeof p.tool_input?.command === 'string' ? p.tool_input.command : '';
      const slm = await adjudicate(
        cfg.slm_url,
        {
          v: 1,
          tool_name: typeof p.tool_name === 'string' ? p.tool_name : '',
          command,
          cwd: typeof p.cwd === 'string' ? p.cwd : '',
          stage1: { class: d.hit.class, decision: d.decision },
          goal: { id: k.goal.id, autonomy: k.goal.autonomy },
          permission_mode: typeof p.permission_mode === 'string' ? p.permission_mode : 'default',
        },
        cfg.slm_timeout_ms
      );
      d = mergeVerdict(d.hit, d, slm, cfg);
      if (!d) return; // calibrated SOFT allow — silent, and nothing is queued
    }
    if (d.defer) {
      // Queue the deferred action for the batched review (ADR-16). Its own try/catch:
      // the queue is presentation metadata, and a failed append must NEVER drop the deny
      // below — the arrest always lands even if the bookkeeping doesn't.
      try {
        appendPending({ ...d.defer, goalId: k.goal.id, sessionId: p.session_id });
      } catch {
        // best-effort — the deny still goes out
      }
    }
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
