import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readStdin, readConfig, toRegExp, capReason, sanitizeText, belayDir } from './util.mjs';
import { readKeyoku, keyokuHome } from './keyoku.mjs';
import { readBudget } from './budget.mjs';
import { appendPending } from './pending.mjs';
import { readLoops } from './loops.mjs';

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
export const HARD_CLASSES = new Set(['git push', 'npm publish', 'gh mutation', 'external send/publish', 'loop control', 'control-file tampering']);
// SOFT: classes where stage 1 provably over-asks (unexpanded-$VAR rm -rf targets, curl
// pipelines with no parseable URL) and a calibrated verdict may refine. SOFT is defined
// as NOT-HARD: these two built-ins plus every config ask_patterns class.
export const SOFT_CLASSES = new Set(['rm -rf outside cwd', 'network write']);

// git/gh/npm mutations that must route to the human. WRAPPER-AWARE (ADR-18): the binary is
// located by a whole-string scan (VCS_SCAN, mirroring RM_SCAN) regardless of shell wrapper
// (`sh -c 'git push'`, `bash -lc`, `eval`, backticks, `$(…)`, `(subshell)`), quoting, or
// chaining (`;`, `&&`, `||`, `|`, a lone `&`, newline) — the old segment-split token walk
// only inspected the leading binary of each `&&`/`;`-delimited segment and let every wrapper
// through. Deliberately OVER-asks (ADR-3: ask, not deny — a false ask is safe, a false allow
// is a fall-arrest failure). Value-taking global options are still consumed so they cannot
// smuggle the subcommand out of view: `git -C DIR push`, `gh -R owner/repo pr merge`.
const GIT_GLOBAL_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
const GH_GLOBAL_ARG = new Set(['-R', '--repo']);
const GH_MUTATION_SUB = new Set(['pr', 'release', 'repo']);
const GH_MUTATION_ACTION = new Set(['create', 'merge', 'edit', 'delete']);
// `gh api` is the general mutation escape hatch: it defaults to GET, but a non-GET method or
// any field/input flag forces a write (repo/release deletion or creation). Classify those.
const GH_API_METHOD = /(?:^|\s)(?:-X|--method)[=\s]*['"]?(?:POST|PUT|PATCH|DELETE)\b/i;
const GH_API_FIELD = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b/;

// Locate git/npm/gh after any command boundary, behind any wrapper. Case-insensitive: a
// case-insensitive FS (macOS default) resolves GIT/NPM/GH to the real binaries. The tail
// runs to the next boundary — the RM_SCAN stop set plus `)` and quotes, so a `sh -c 'git
// push'` tail ends at the closing quote instead of swallowing the rest of the line.
const VCS_SCAN = /(?:^|[\s;|&`'"(=\\])(?:[\w./-]*\/)?(git|npm|gh)\b([^\n;|&`)'"]*)/gi;

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

/** git push / npm publish / gh (pr|release|repo) (create|merge|edit|delete) / gh api write,
 *  found regardless of wrapper or quoting, or null. */
function classifyVcs(command) {
  if (typeof command !== 'string' || !command) return null;
  VCS_SCAN.lastIndex = 0;
  let m;
  while ((m = VCS_SCAN.exec(command))) {
    const bin = m[1].toLowerCase();
    const tok = m[2].trim().split(/\s+/).filter(Boolean);
    if (bin === 'git') {
      if (nextSubcommand(tok, 0, GIT_GLOBAL_ARG).sub === 'push') return 'git push';
    } else if (bin === 'npm') {
      // `publish` as a standalone token anywhere in the tail — value-taking npm global
      // options (`--registry <url> publish`, `--otp <code> publish`, `--workspace <w>
      // publish`) take a SEPARATE argument a fixed option-set can't enumerate, so the old
      // "first non-option token" walk returned the flag's value instead of `publish`.
      if (tok.includes('publish')) return 'npm publish';
    } else if (bin === 'gh') {
      const first = nextSubcommand(tok, 0, GH_GLOBAL_ARG);
      if (GH_MUTATION_SUB.has(first.sub)) {
        const action = nextSubcommand(tok, first.idx + 1, GH_GLOBAL_ARG);
        if (GH_MUTATION_ACTION.has(action.sub)) return 'gh mutation';
      }
      if (first.sub === 'api') {
        const tail = tok.join(' ');
        if (GH_API_METHOD.test(` ${tail}`) || GH_API_FIELD.test(` ${tail}`)) return 'gh mutation';
      }
    }
  }
  return null;
}

// External sends via MCP tools (Slack messages, Gmail drafts/sends, generic publish).
// Scoped to mcp__ tools on purpose: built-in harness tools (e.g. subagent SendMessage)
// are in-session coordination, not external side effects.
const TOOLNAME_ASK = /^mcp__.*(send|publish|add_message|post_message|create_draft)/i;

// Loop-control / verifier-integrity class (ADR-19): the tools that can REMOVE the arrest or
// WEAKEN the success criteria that are holding the session. Gating them closes two holes at
// once — (1) the self-liberation path (under bypassPermissions the model could disarm/unfocus
// itself, no human ever contacted, then run the denied action into a now-inert gate), and
// (2) verifier tampering (goal_update/converge/delete on the goal that holds it = editing the
// test instead of doing the work). HARD class: never SLM-unlockable. Only ever fires while a
// focused autonomous goal already exists, so normal keyoku use is untouched. goal_focus is
// gated too (refute F1): re-focusing to a DIFFERENT goal displaces keyoku's singleton focus off
// the arrest goal — self-liberation exactly like goal_unfocus. (belay's own loop create/disarm
// reach keyoku through a spawned child, not a Claude Code tool call, so they are never gated by
// this; only the model calling the tool directly is.)
const LOOP_CONTROL_ASK = /^mcp__(belay__belay_loop_disarm|keyoku__goal_(focus|unfocus|update|converge|delete))\b/i;

// Writes to belay's or keyoku's OWN control files (~/.belay, ~/.keyoku) are self-liberation by
// another name (refute F1): `touch ~/.keyoku/paused` no-ops the whole harness, `> …/focus.json`
// clears the arrest, `echo '{"gate_enabled":false}' > ~/.belay/config.json` disables the gate.
// The model never needs to WRITE these under an autonomous loop (belay and keyoku own them), so
// any write-ish command targeting them routes to the human. Pure reads are left alone.
const CONTROL_DIR = /\.(keyoku|belay)\b/;
const WRITE_UTIL = /(?:^|[\s;|&`(\\])(?:[\w./-]*\/)?(?:touch|rm|mv|cp|sed|tee|dd|ln|truncate|chmod|chown|install|unlink|shred|mkdir|rmdir|python3?|node|perl)\b/i;
/** Does `text` reference belay's or keyoku's control dir — by the default `.keyoku`/`.belay`
 *  names OR by the ACTUALLY configured path (env overrides like BELAY_DIR don't use the dotted
 *  names, so the literal-name check alone was blind to them). Shared by the whole-command check
 *  and the B9 redirect-target check below (a substring test, so it works on any slice of the
 *  command, not just the full string). */
function dirRefIn(text) {
  if (typeof text !== 'string' || !text) return false;
  if (CONTROL_DIR.test(text)) return true;
  try {
    const b = belayDir();
    const k = keyokuHome();
    return (!!b && text.includes(b)) || (!!k && text.includes(k));
  } catch {
    return false; // env read failed → literal names only
  }
}
const referencesControlDir = dirRefIn;

// B9 (read-only false positive): `cat ~/.belay/loops.json` and `grep .belay src/*.mjs` were
// bogus 'control-file tampering' defers — the OLD check gated on "a redirect/mutating-verb
// exists ANYWHERE on the line" + "the control dir is referenced ANYWHERE on the line",
// independently, so a plain read that merely SEARCHES for '.belay' (a grep pattern, not even
// a path) alongside an UNRELATED redirect elsewhere (`grep .belay src/ > /tmp/out.txt`) got
// gated even though nothing ever writes into the control dir. Tighten: a command built
// ENTIRELY from read-only inspection utilities (cat/grep/head/tail/less/wc/nm/file — every
// top-level `;`/`|`/`&`-delimited segment led by one of these, and no `tee`/other WRITE_UTIL
// verb anywhere) is read-only UNLESS one of its OWN redirect targets (`>`/`>>`, tail-scoped to
// the next command boundary) resolves into the control dir — `cat x > ~/.belay/y.json` stays
// gated (a genuine write hiding behind an otherwise-safe verb); `grep .belay src/*.mjs >
// /tmp/out.txt` (redirect target is unrelated) does not. Any command NOT built entirely from
// this allowlist (any wrapper, any other verb, any tee) falls straight through to the
// pre-existing broad check below, UNCHANGED — this only ever REMOVES false positives on a
// provably-read-only pipeline; it never widens what a write-capable command can get away with.
const READ_ONLY_LEADING = new Set(['cat', 'grep', 'head', 'tail', 'less', 'wc', 'nm', 'file']);
const LEADING_BIN = /^\s*(?:[\w./-]*\/)?([\w.-]+)/;
const REDIRECT_SCAN = /[012]?>>?([^\n;|&`]*)/g;

/** Is `command` built ENTIRELY from top-level segments (split on `;`/`|`/`&`/newline) each
 *  led by a read-only inspection utility, with no `tee` and no other WRITE_UTIL verb anywhere
 *  (checked broadly — not just as a segment leader — so it can't be smuggled in as a non-
 *  leading token either)? A wrapper (`sh -c`, `env`, `sudo`, backticks, `$(...)`) is
 *  deliberately NOT unwrapped here — its leading token won't be in the allowlist, so it just
 *  falls through to the broad check, exactly like today. */
function isReadOnlyPipeline(command) {
  if (WRITE_UTIL.test(command)) return false; // any mutating verb (incl. tee) anywhere → not read-only
  const segments = command
    .split(/[\n;|&]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return false;
  for (const seg of segments) {
    const m = LEADING_BIN.exec(seg);
    const bin = m ? m[1].toLowerCase() : '';
    if (!READ_ONLY_LEADING.has(bin)) return false;
  }
  return true;
}

export function controlFileTamper(command) {
  if (typeof command !== 'string' || !command) return false;
  if (!referencesControlDir(command)) return false;
  if (isReadOnlyPipeline(command)) {
    // Still gate a redirect whose OWN target lands in the control dir — a write disguised
    // behind a read-only verb (`cat x > ~/.belay/y.json`). Tail-scoped to the next command
    // boundary (mirrors RM_SCAN/VCS_SCAN's own tail-capture technique elsewhere in this file).
    REDIRECT_SCAN.lastIndex = 0;
    let m;
    while ((m = REDIRECT_SCAN.exec(command))) {
      if (dirRefIn(m[1])) return true;
    }
    return false;
  }
  return /[12]?>>?/.test(command) || WRITE_UTIL.test(command); // unchanged broad path: a redirect, or a mutating utility, alongside the control dir
}

// ── Config-driven danger table (ADR-18) ────────────────────────────────────────────────
// Beyond the bespoke git/npm/gh/curl/rm classifiers below (which need real argument parsing),
// a DATA-DRIVEN table covers the long tail of irreversible/external CLIs by binary +
// subcommand. Built-in defaults ship the clearly-irreversible verbs; the user extends the
// table from ~/.belay/config.json `danger_binaries` (UNIONED in — a user's list ADDS to that
// binary's built-in list, never dropping built-in coverage), so covering their stack
// (aws, kubectl apply, psql, …)
// is one config line, never a code change. `['*']` = the whole binary is dangerous (ask on
// every invocation) — the right choice for CLIs where reads and writes share the command tree
// (aws/gcloud/az). Over-asks by design (ADR-3). Left OUT of defaults on purpose: aws/gcloud/az
// (too read-heavy to `*` by default) and kubectl apply/helm install (dev-common) — one line each.
export const DEFAULT_DANGER_BINARIES = {
  docker: ['push'],
  podman: ['push'],
  terraform: ['apply', 'destroy'],
  tofu: ['apply', 'destroy'],
  pulumi: ['up', 'destroy'],
  kubectl: ['delete', 'drain'],
  helm: ['uninstall', 'rollback'],
  pnpm: ['publish'],
  yarn: ['publish'],
  bun: ['publish'],
  hg: ['push'],
  dvc: ['push'],
  vercel: ['deploy', 'promote'],
  netlify: ['deploy'],
  flyctl: ['deploy'],
  fly: ['deploy'],
  wrangler: ['deploy', 'publish'],
};

/** Built-in danger table UNIONED with the user's config additions (per-binary the two lists
 *  merge, so a user addition never drops built-in coverage for that binary). */
function mergedDangerTable(cfg) {
  const user = cfg && cfg.danger_binaries && typeof cfg.danger_binaries === 'object' && !Array.isArray(cfg.danger_binaries) ? cfg.danger_binaries : {};
  const out = { ...DEFAULT_DANGER_BINARIES };
  for (const [bin, subs] of Object.entries(user)) {
    if (!Array.isArray(subs) || subs.length === 0) continue;
    const key = bin.toLowerCase();
    out[key] = out[key] ? [...new Set([...out[key], ...subs])] : [...subs];
  }
  return out;
}

// Any binary token after a command boundary, behind any wrapper. The match captures ONLY the
// binary (no greedy tail): a greedy tail on a leading wrapper token (`env FOO=bar docker push`)
// would swallow the real binary, so the scan must advance token-by-token and re-anchor on the
// next boundary. The subcommand is read from the substring AFTER the match. Table lookup does
// the filtering, so the broad per-token match is cheap.
const DANGER_SCAN = /(?:^|[\s;|&`'"(=\\])(?:[\w./-]*\/)?([\w.-]+)\b/gi;
const EMPTY_SET = new Set();

/** Table-driven danger classification: a listed binary whose first subcommand is dangerous
 *  (or whose whole invocation is, via `['*']`). Returns the class string or null. */
function classifyDanger(command, cfg) {
  if (typeof command !== 'string' || !command) return null;
  const table = mergedDangerTable(cfg);
  DANGER_SCAN.lastIndex = 0;
  let m;
  while ((m = DANGER_SCAN.exec(command))) {
    const bin = m[1].toLowerCase();
    const subs = table[bin];
    if (!Array.isArray(subs) || subs.length === 0) continue;
    if (subs.includes('*')) return bin; // whole-binary danger (e.g. a user's aws:['*'])
    const rest = command.slice(m.index + m[0].length).split(/[\n;|&`)'"]/)[0]; // tail up to the next boundary
    const tok = rest.trim().split(/\s+/).filter(Boolean);
    const sub = (nextSubcommand(tok, 0, EMPTY_SET).sub || '').toLowerCase();
    if (sub && subs.includes(sub)) return `${bin} ${sub}`;
  }
  return null;
}

// Locate every rm invocation regardless of shell wrapper or quoting: after a command
// boundary / whitespace / quote / '(' / '=' , an optional path prefix (/bin/rm), then rm.
// Case-insensitive (a case-insensitive FS resolves RM). The tail runs to the next boundary.
const RM_SCAN = /(?:^|[\s;|&`'"(=\\])(?:[\w./-]*\/)?rm\b([^\n;|&`]*)/gi;

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
    // xargs / find -exec feed rm's targets from ELSEWHERE — the args we can see ({} , the
    // literal placeholders) are not the real targets, which can be anywhere on the filesystem.
    const preRun = command.slice(0, m.index).split(/[\n;|&`]/).pop() || '';
    if (/\bxargs\b/.test(preRun)) return true;
    if (/\bfind\b[^\n]*-execdir?\b/i.test(preRun)) return true; // find … -exec rm -rf {} +
    const paths = toks.filter((t) => !t.startsWith('-'));
    if (paths.length === 0) return true; // no explicit target (stdin/xargs/redirect) → can't prove inside
    for (const t of paths) {
      if (t === '{}' || t === '+' || t === ';') return true; // find -exec placeholder → real targets are find's matches
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

/** curl/wget performing a non-GET / body-upload request to anything that isn't localhost.
 *  Case-insensitive, and aware of curl's bundled (`-sX POST`) and attached (`-da=1`,
 *  `-Tfile`) short options, plus DELETE/PATCH — not just POST/PUT. Over-asks (ADR-3). */
export function externalNetworkWrite(command) {
  if (typeof command !== 'string' || !command) return false;
  const hasCurl = /\bcurl\b/i.test(command);
  if (!hasCurl && !/\bwget\b/i.test(command)) return false;
  const METHOD = /(?:^|\s)(?:-[a-zA-Z]*X|--request|--method)[=\s]*['"]?(?:POST|PUT|PATCH|DELETE)\b/i; // incl. bundled -sX / attached -XPOST
  const LONG_BODY = /(?:^|\s)(?:--data\b|--data-\w+\b|--json\b|--form\b|--upload-file\b|--post-data\b|--post-file\b|--body-data\b|--body-file\b)/i;
  // A curl short bundle whose flag chars include a body/form/upload flag (d/F/T) — the rest
  // of the bundle is that flag's value. Curl-only: wget's -d/-F/-T mean debug/force-html/timeout.
  const CURL_BUNDLE = /(?:^|\s)-[a-zA-Z]*[dFT]/;
  const writey = METHOD.test(command) || LONG_BODY.test(command) || (hasCurl && CURL_BUNDLE.test(command));
  if (!writey) return false;
  const urls = command.match(/https?:\/\/[^\s"']+/gi) || [];
  const local = /^https?:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)([:/?#]|$)/i;
  if (urls.length > 0 && urls.every((u) => local.test(u))) return false;
  return true; // includes "no parseable URL": default deny→ask for this class
}

/** First matching irreversible/external class, or null. Config ask_patterns are tested
 *  against BOTH the tool name and the Bash command string. */
export function classify(name, command, cwd, cfg) {
  // Join shell line-continuations before scanning (refute F4): bash treats `\<newline>` as a
  // single space, so `git \⏎push` is `git push` — otherwise the newline severs the subcommand.
  const cmd = typeof command === 'string' ? command.replace(/\\\r?\n/g, ' ') : command;
  if (cmd) {
    const vcs = classifyVcs(cmd);
    if (vcs) return { class: vcs, note: null };
    if (rmrfOutsideCwd(cmd, cwd)) return { class: 'rm -rf outside cwd', note: null };
    if (externalNetworkWrite(cmd)) return { class: 'network write', note: null };
    if (controlFileTamper(cmd)) return { class: 'control-file tampering', note: null };
  }
  if (name && LOOP_CONTROL_ASK.test(name)) return { class: 'loop control', note: null };
  if (name && TOOLNAME_ASK.test(name)) return { class: 'external send/publish', note: null };
  // User ask_patterns run BEFORE the built-in danger table so a user can customize the class
  // label + note for a command the table would otherwise catch generically. They only ever
  // ADD an ask, and the irreversible safety core above already ran, so nothing is downgraded.
  for (const p of cfg.ask_patterns) {
    const re = toRegExp(p.pattern);
    if (!re) continue;
    if ((cmd && re.test(cmd)) || (name && re.test(name))) return { class: p.class || 'custom', note: p.note || null };
  }
  if (cmd) {
    const danger = classifyDanger(cmd, cfg);
    if (danger) return { class: danger, note: null };
  }
  return null;
}

// ── B6/ADR-28: loop-autonomy outward-action allowlist ──────────────────────────────────
// A loop's declared `autonomy` (~/.belay/loops.json entry — 'L0' default/unset | 'L1' | 'L2',
// set via belay_loop_create/`belay loop create --autonomy`, src/loops.mjs) lets the gate
// PERMIT (a true silent allow — nothing staged, nothing queued) a NARROW allowlist of
// otherwise-staged outward actions instead of deferring/asking. This is deliberately an
// ALLOWLIST, not a denylist: every class NOT explicitly recognized below (npm publish,
// control-file tampering, loop control, external send/publish, rm -rf, network write, the
// config danger table, custom ask_patterns, and gh release/repo/api mutations) is untouched
// by this section and falls straight through to the existing ask/defer path — AT EVERY
// LEVEL, including L2. That is what keeps the always-gated invariant (docs/DECISIONS.md
// ADR-28) true BY CONSTRUCTION rather than by an exclusion list this code would have to keep
// in sync. Over-detection in every helper below is the SAFE direction (stays staged, never
// permits) — "can't prove it's safe → treat as unsafe."
//
// Known, accepted interaction: when the OPT-IN stage-2 catch-mode (`slm_enabled`+`slm_catch`,
// default OFF) is also on, a permitted action still reaches hookPreToolUse's catch-mode branch
// (it sees "stage 1 found nothing to gate", same as any ungated command) and MAY be flagged by
// the learned adjudicator anyway. This can only ADD friction, never remove it (catch-mode is
// itself fail-safe-only per ADR-17 — an untrusted/broken daemon can at worst over-ask, never
// fail open), so it is not a hole in the always-gated invariant; it is simply extra scrutiny
// for operators who opted into both features at once.

const GIT_PUSH_FORCE_FLAG = /^(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease|-if-includes)?(?:=.*)?)$/i;
const PROTECTED_PUSH_FLAG = /^--(?:all|mirror|branches)$/i;

/** Strip a `src:dst` refspec / `refs/heads/` prefix / leading `+` down to a bare branch
 *  name, then test it against main/master (case-insensitive). */
function isProtectedRefspec(tok) {
  const dst = tok.includes(':') ? tok.slice(tok.indexOf(':') + 1) : tok;
  const name = dst.replace(/^\+/, '').replace(/^refs\/heads\//i, '');
  return /^(?:main|master)$/i.test(name);
}

/**
 * Inspect every `git push` invocation on the (already line-joined) command, wrapper-aware —
 * reuses classifyVcs's own VCS_SCAN/nextSubcommand so it agrees with what classify() actually
 * matched. Returns null when no push is found there (should not happen when hitClass is
 * already 'git push', but never assumed); otherwise { forced, protectedTarget }:
 *   - forced: true if ANY located invocation carries a force flag (-f, --force,
 *     --force-with-lease[=...], --force-if-includes, or a short bundle containing an 'f') —
 *     over-broad on purpose, since a false positive here only means "stays staged."
 *   - protectedTarget: true if ANY located invocation could touch main/master, INCLUDING when
 *     the target cannot be proven — a bare `git push` / `git push origin` names no branch, the
 *     current branch could BE main, and that cannot be known from the command text alone, so
 *     "unprovable" is treated as "protected" (fail-safe). `--all`/`--mirror`/`--branches` are
 *     the same: broad/ambiguous targets are conservatively protected.
 * Multiple chained pushes are ALL inspected — one qualifying invocation taints the whole line
 * (same "one bad segment gates everything" principle as rmrfOutsideCwd/externalNetworkWrite).
 */
export function analyzeGitPush(command) {
  if (typeof command !== 'string' || !command) return null;
  VCS_SCAN.lastIndex = 0;
  let m;
  let found = false;
  let forced = false;
  let protectedTarget = false;
  while ((m = VCS_SCAN.exec(command))) {
    if (m[1].toLowerCase() !== 'git') continue;
    const tok = m[2].trim().split(/\s+/).filter(Boolean);
    const first = nextSubcommand(tok, 0, GIT_GLOBAL_ARG);
    if (first.sub !== 'push') continue;
    found = true;
    const rest = tok.slice(first.idx + 1);
    const flags = rest.filter((t) => t.startsWith('-'));
    const nonFlags = rest.filter((t) => !t.startsWith('-'));
    if (flags.some((f) => GIT_PUSH_FORCE_FLAG.test(f))) forced = true;
    if (flags.some((f) => PROTECTED_PUSH_FLAG.test(f))) protectedTarget = true;
    if (nonFlags.length < 2) {
      protectedTarget = true; // no explicit branch/refspec given — cannot prove it isn't main
    } else if (nonFlags.slice(1).some(isProtectedRefspec)) {
      protectedTarget = true;
    }
  }
  return found ? { forced, protectedTarget } : null;
}

/**
 * True only when EVERY `gh` mutation found on the (already line-joined) command is a `gh pr`
 * create/merge/edit/delete — false the moment a `gh release`/`gh repo`/`gh api` write is ALSO
 * present anywhere on the same line (fail-safe: one disqualifying mutation stages the whole
 * line, mirroring analyzeGitPush's "one bad segment taints everything").
 */
export function isGhPrOnlyWrite(command) {
  if (typeof command !== 'string' || !command) return false;
  VCS_SCAN.lastIndex = 0;
  let m;
  let sawPrWrite = false;
  let sawOtherMutation = false;
  while ((m = VCS_SCAN.exec(command))) {
    if (m[1].toLowerCase() !== 'gh') continue;
    const tok = m[2].trim().split(/\s+/).filter(Boolean);
    const first = nextSubcommand(tok, 0, GH_GLOBAL_ARG);
    if (first.sub === 'pr') {
      const action = nextSubcommand(tok, first.idx + 1, GH_GLOBAL_ARG);
      if (GH_MUTATION_ACTION.has(action.sub)) sawPrWrite = true;
      continue;
    }
    if (GH_MUTATION_SUB.has(first.sub)) {
      const action = nextSubcommand(tok, first.idx + 1, GH_GLOBAL_ARG);
      if (GH_MUTATION_ACTION.has(action.sub)) sawOtherMutation = true;
      continue;
    }
    if (first.sub === 'api') {
      const tail = tok.join(' ');
      if (GH_API_METHOD.test(` ${tail}`) || GH_API_FIELD.test(` ${tail}`)) sawOtherMutation = true;
    }
  }
  return sawPrWrite && !sawOtherMutation;
}

/**
 * Is this specific classified hit on the loop's declared-level outward allowlist? Pure.
 * `level` is the loop's raw `autonomy` field (or null/anything else, e.g. absent/'L0') —
 * only exactly 'L1' or 'L2' can ever permit anything; every other value (including undefined,
 * null, 'L0', or a corrupt/unexpected string) falls through to `false` (stays staged),
 * fail-safe by construction. Command is normalized the same way classify() does (shell
 * line-continuations joined) so the scanners here see exactly what classify() saw.
 */
export function autonomyPermits(level, hitClass, command) {
  if (level !== 'L1' && level !== 'L2') return false;
  const cmd = typeof command === 'string' ? command.replace(/\\\r?\n/g, ' ') : command;
  if (hitClass === 'git push') {
    const gp = analyzeGitPush(cmd);
    if (!gp || gp.forced) return false; // unparseable, or any force flag → never permit
    return level === 'L2' ? true : !gp.protectedTarget; // L1: never main/master or unprovable
  }
  if (hitClass === 'gh mutation') {
    return isGhPrOnlyWrite(cmd); // pr writes ONLY — repo/release/api stay staged at every level
  }
  return false; // everything else: unchanged at every level, including L2
}

/** The declared autonomy of the loop that owns `goalId` — 'L1'/'L2' only; anything else
 *  (no loops.json entry, no `autonomy` field, or an unrecognized value) degrades to null,
 *  which autonomyPermits treats as "stage everything" (today's behavior). Never throws
 *  (readLoops() never throws — absent/malformed loops.json degrades to {loops:{}}). */
export function loopAutonomy(goalId) {
  if (typeof goalId !== 'string' || !goalId) return null;
  const e = readLoops().loops[goalId];
  return e && typeof e === 'object' && (e.autonomy === 'L1' || e.autonomy === 'L2') ? e.autonomy : null;
}

/** bypassPermissions sessions auto-resolve "ask" — the action runs with no prompt ever
 *  shown (observed live 2026-07-02: the gate emitted ask, `git push --dry-run` executed
 *  anyway). ADR-3's contract is "the question gets asked"; when the harness cannot ask,
 *  the only way to keep the human in the loop is deny-with-instructions ("deny" IS
 *  enforced under bypass; "ask" is not). ADR-13.
 *
 *  The guidance deliberately does NOT offer "disarm the loop, then retry" (ADR-19): that
 *  path launders the arrest — disarm/unfocus are themselves loop-control actions gated here,
 *  and standing the loop down does not make the irreversible action approved. The only honest
 *  route is a session where a human can actually see the prompt. */
function escalateForBypass(p, d) {
  if (!d || d.decision !== 'ask' || p.permission_mode !== 'bypassPermissions') return d;
  return {
    decision: 'deny',
    reason: capReason(
      `${d.reason}. This session runs bypassPermissions, where an approval prompt cannot be shown — denied instead of silently allowed (ADR-13). To proceed, run this exact action from a session WITHOUT bypassPermissions. Standing the loop down does not make it approved (the arrest is not the obstacle — the absent human is), and loop-control actions like unfocus/disarm are gated here for the same reason (ADR-19).`
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
    // B6/ADR-28: the FOCUSED loop's declared autonomy may PERMIT this specific hit — a true
    // silent allow, bypassing gate_mode/bypassPermissions/queueing entirely. Checked first so
    // a permitted action never gets staged even under gate_mode:'defer'. `k.goal` is present
    // by the guard above; `loopAutonomy` reads belay's OWN loops.json (never keyoku's), the
    // same store B3's session-ownership resolution uses.
    if (autonomyPermits(loopAutonomy(k.goal.id), hit.class, command)) return null;
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

/**
 * Catch-mode (ADR-17 extension): stage 1 found NOTHING (the denylist is fundamentally incomplete
 * — `$(echo git) push`, `eval $var`, a binary not in the table). The daemon is asked whether the
 * command is dangerous ANYWAY. Because catch only ever ADDS friction, an untrusted/broken/slow
 * daemon can at worst cause an over-ask — NEVER a fail-open — so it is safe to trust on the
 * stage-1-miss path. Acceptance bar mirrors refine but in the safe direction: a well-formed,
 * non-abstaining, high-confidence 'deny'/'ask' verdict → gate it (ask, or a defer-queue deny in
 * `gate_mode:'defer'`); anything else (allow / abstain / low-confidence / malformed / absent) →
 * null (the command passes, byte-identical to catch-mode being off). Pure — the network call
 * lives in the hook. Returns a decision object or null.
 */
export function catchVerdict(slmResponse, cfg, ctx = {}) {
  if (!wellFormedVerdict(slmResponse) || slmResponse.abstain !== false) return null;
  // The §3 verdict enum is allow|defer|ask (there is no 'deny'): the daemon flags danger by
  // asking for friction (`ask` or `defer`). Accept those at/above τ; `allow`/low-confidence → pass.
  if ((slmResponse.verdict !== 'ask' && slmResponse.verdict !== 'defer') || slmResponse.confidence < cfg.slm_min_confidence) return null;
  const why = typeof slmResponse.rationale === 'string' && slmResponse.rationale ? ` — ${sanitizeText(slmResponse.rationale, 160)}` : '';
  if (cfg.gate_mode === 'defer') {
    return {
      decision: 'deny',
      reason: capReason(`[belay] the learned adjudicator flagged this action under an autonomous goal — deferred and queued for batched human approval; continue with sandbox-safe work${why}`),
      defer: { class: 'slm-flagged', tool_name: typeof ctx.tool_name === 'string' ? ctx.tool_name : '', command: (typeof ctx.command === 'string' ? ctx.command : '').slice(0, 500) },
    };
  }
  return { decision: 'ask', reason: capReason(`[belay] the learned adjudicator flagged this action as irreversible/dangerous under an autonomous goal — requires human approval${why}`) };
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
    const command = typeof p.tool_input?.command === 'string' ? p.tool_input.command : '';
    const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';
    const mode = typeof p.permission_mode === 'string' ? p.permission_mode : 'default';
    let d = decideGate(p, k, budget, cfg);
    if (!d) {
      // Catch-mode (ADR-17 ext): stage 1 found nothing. If enabled, ask the daemon whether the
      // command is dangerous ANYWAY — closes the denylist's incompleteness. Only for a real
      // command; add-friction only, so ANY daemon failure → the command passes (byte-identical to
      // catch-mode off). decideGate stays pure; the network call is here.
      if (cfg.slm_enabled && cfg.slm_catch && command) {
        const slm = await adjudicate(
          cfg.slm_url,
          { v: 1, mode: 'catch', tool_name: toolName, command, cwd: typeof p.cwd === 'string' ? p.cwd : '', goal: { id: k.goal.id, autonomy: k.goal.autonomy }, permission_mode: mode },
          cfg.slm_timeout_ms
        );
        d = escalateForBypass(p, catchVerdict(slm, cfg, { tool_name: toolName, command }));
      }
      if (!d) return;
    } else if (cfg.slm_enabled && d.hit && !HARD_CLASSES.has(d.hit.class) && mode !== 'bypassPermissions') {
      // Refine (ADR-17): a SOFT-class stage-1 hit may be UNLOCKED by a calibrated allow. Never for
      // HARD classes (not unlockable), never for the spawn-budget ask (no `hit`), never under
      // bypassPermissions (the ADR-13 deny stays final).
      const slm = await adjudicate(
        cfg.slm_url,
        {
          v: 1,
          tool_name: toolName,
          command,
          cwd: typeof p.cwd === 'string' ? p.cwd : '',
          stage1: { class: d.hit.class, decision: d.decision },
          goal: { id: k.goal.id, autonomy: k.goal.autonomy },
          permission_mode: mode,
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
    // Journal the gate ACT (ask/deny) so it is measurable by `belay insights` — only when the
    // gate actually acts (rare), never on the silent-allow hot path, so this adds nothing to the
    // 99% case. Best-effort: a journal failure must never affect the decision.
    try {
      (await import('./stop.mjs')).journalStop(p, d.hit?.class ?? d.defer?.class ?? 'gate', d.decision, k.goal?.id ?? null);
    } catch {
      // observability only
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
