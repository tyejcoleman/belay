import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'belay.mjs');
export const fakeKeyokuBin = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-keyoku.mjs');
export const refocusFixtureBin = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'refocus-then-fake-keyoku.mjs');
export const nowSec = () => Math.round(Date.now() / 1000);
export const iso = (sec) => new Date(sec * 1000).toISOString();

/** Fresh isolated homes for every synthetic world. */
export function homes() {
  const base = mkdtempSync(join(tmpdir(), 'belay-'));
  return { base, keyoku: join(base, 'keyoku'), tokenroom: join(base, 'tokenroom'), belay: join(base, 'belay'), config: join(base, 'claude') };
}

export const env = (h) => {
  const e = {
    ...process.env,
    KEYOKU_HOME: h.keyoku,
    TOKENROOM_DIR: h.tokenroom,
    BELAY_DIR: h.belay,
    CLAUDE_CONFIG_DIR: h.config,
  };
  // Hermeticity (refute-audit F1): nothing in a test world may resolve the DEVELOPER's
  // real registrations. claudeJsonPath() is ruled by CLAUDE_CONFIG_DIR (no fallthrough),
  // and the KEYOKU_INSTALL / CLAUDE_JSON escape hatches must not leak in from the shell.
  delete e.KEYOKU_INSTALL;
  delete e.CLAUDE_JSON;
  delete e.CLAUDE_CODE_SESSION_ID; // the developer's live session id must not leak into a spawned belay child (B7 `belay await` reads it as a fallback)
  return e;
};

/** Spawn the real bin — the tests exercise the exact process the harness runs. */
export function run(h, args, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
    encoding: 'utf8',
    env: env(h),
  });
}

export const goal = (over = {}) => ({
  id: 'goal_test1',
  slug: 'ship-widget',
  objective: 'ship the widget',
  criteria: [
    { id: 'c1', description: 'tests green' },
    { id: 'c2', description: 'deployed to prod' },
  ],
  constraints: [],
  autonomy: 'autonomous',
  maxIterations: 50,
  usedIterations: 3,
  status: 'active',
  createdAt: iso(nowSec() - 3600),
  lastAssessedAt: iso(nowSec() - 120),
  ...over,
});

export const focusFor = (over = {}) => ({ goalId: 'goal_test1', goalSlug: 'ship-widget', cwd: '/tmp/proj', at: iso(nowSec() - 60), ...over });

export const obs = (over = {}) => ({ goalId: 'goal_test1', kind: 'assessment', summary: '2 of 3 criteria unmet', unmet: ['c1', 'c2'], id: 'obs_x', at: iso(nowSec() - 120), ...over });

export function writeKeyoku(h, { goals, focus, obsLines, paused } = {}) {
  mkdirSync(join(h.keyoku, 'observations'), { recursive: true });
  if (paused) writeFileSync(join(h.keyoku, 'paused'), '');
  if (goals !== undefined) writeFileSync(join(h.keyoku, 'goals.json'), typeof goals === 'string' ? goals : JSON.stringify(goals, null, 2));
  if (focus !== undefined) writeFileSync(join(h.keyoku, 'focus.json'), typeof focus === 'string' ? focus : JSON.stringify(focus));
  if (obsLines) {
    const gid = (obsLines.find((l) => typeof l === 'object' && l?.goalId) ?? {}).goalId ?? 'goal_test1';
    writeFileSync(join(h.keyoku, 'observations', `${gid}.jsonl`), obsLines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
}

export function writeTokenroom(h, { leftPct = 72, resetsInMin = 180, estTokens = 230000, updatedAgoSec = 30 } = {}) {
  mkdirSync(h.tokenroom, { recursive: true });
  writeFileSync(
    join(h.tokenroom, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: nowSec() - updatedAgoSec,
      windows: { five_hour: { used_pct: 100 - leftPct, resets_at: nowSec() + resetsInMin * 60 } },
      burn: { est_tokens_left: estTokens },
    })
  );
}

/**
 * Write profiles.json in tokenroom's REAL shape (src/accounts.mjs):
 *   { profiles: { <label>: { keys, last_seen, last_windows_snapshot:{ at, five_hour:{used_pct,resets_at} } } } }
 * Accepts a per-label options bag: { left_pct|leftPct, updated_at|at|updatedAgoSec,
 * resetsInMin|resetsAt, keys }. Kept back-compatible with the old
 * `{ work: { left_pct, updated_at } }` call sites — they now exercise the real contract.
 */
export function writeProfiles(h, profiles) {
  mkdirSync(h.tokenroom, { recursive: true });
  const out = {};
  for (const [label, o = {}] of Object.entries(profiles)) {
    const at = o.at ?? o.updated_at ?? nowSec() - (o.updatedAgoSec ?? 60);
    const leftPct = o.leftPct ?? o.left_pct ?? 0;
    out[label] = {
      keys: o.keys ?? [`key-${label}`],
      last_seen: at,
      last_windows_snapshot: {
        at,
        five_hour: { used_pct: 100 - leftPct, resets_at: o.resetsAt ?? nowSec() + (o.resetsInMin ?? 180) * 60 },
      },
    };
  }
  writeFileSync(join(h.tokenroom, 'profiles.json'), JSON.stringify({ profiles: out }));
}

export const stopPayload = (over = {}) => ({ session_id: 's1', cwd: '/tmp/proj', stop_hook_active: false, ...over });

export const toolPayload = (over = {}) => ({ session_id: 's1', cwd: '/tmp/proj', tool_name: 'Bash', tool_input: { command: 'ls' }, ...over });

// ── SOTA round-0 fixtures (docs/DESIGN.md §6.0.2 — FROZEN for the build round) ─────────

/** ~/.belay/loops.json — accepts a bare {goalId: entry} map or the full {loops:{…}} shape.
 *  Entry defaults follow §3.1: {armed:true, paused:false, armed_at, armed_by:'user'}. */
export function writeLoops(h, loops) {
  mkdirSync(h.belay, { recursive: true });
  const map = loops && typeof loops === 'object' && loops.loops ? loops.loops : loops ?? {};
  const out = {};
  for (const [goalId, over] of Object.entries(map)) {
    out[goalId] = { armed: true, paused: false, armed_at: nowSec() - 60, armed_by: 'user', paused_at: null, ...over };
  }
  writeFileSync(join(h.belay, 'loops.json'), typeof loops === 'string' ? loops : JSON.stringify({ loops: out }, null, 2));
}

/** ~/.belay/proposals.json — accepts an array of (partial) proposal rows or {proposals:[…]}. */
export function writeProposals(h, proposals) {
  mkdirSync(h.belay, { recursive: true });
  const arr = Array.isArray(proposals) ? proposals : proposals?.proposals ?? [];
  const out = arr.map((p, i) => ({
    id: `prop-${i + 1}`,
    kind: 'unfocused-autonomous',
    summary: 'proposal',
    evidence: {},
    suggested_create: {},
    created_at: nowSec() - 60,
    status: 'open',
    surfaced_count: 0,
    ...p,
  }));
  writeFileSync(join(h.belay, 'proposals.json'), typeof proposals === 'string' ? proposals : JSON.stringify({ proposals: out }, null, 2));
}

/** ~/.tokenroom/resume.json in tokenroom's real shape (src/resume.mjs):
 *  {summary(≤500), est_tokens, created_at, resume_at}. resumeAtAgoSec > 0 → resume time
 *  already passed (S1 ready); negative → still in the future. */
export function writeResume(h, { summary = 'finish the deferred migration', resumeAtAgoSec = 60, estTokens = 12000, createdAgoSec = 3600 } = {}) {
  mkdirSync(h.tokenroom, { recursive: true });
  writeFileSync(
    join(h.tokenroom, 'resume.json'),
    JSON.stringify({ summary, est_tokens: estTokens, created_at: nowSec() - createdAgoSec, resume_at: nowSec() - resumeAtAgoSec })
  );
}

/** ~/.keyoku/ripe.json — keyoku's background-nudge cache: {at, suggestions[]}. */
export function writeRipe(h, suggestions = [], { atAgoSec = 60 } = {}) {
  mkdirSync(h.keyoku, { recursive: true });
  writeFileSync(join(h.keyoku, 'ripe.json'), JSON.stringify({ at: iso(nowSec() - atAgoSec), suggestions }));
}

/**
 * Seed <h.config>/.claude.json registering a keyoku MCP server — by default the
 * fake-keyoku fixture pointed at this world's KEYOKU_HOME. stack.mjs claudeJsonPath()
 * finds it via the CLAUDE_CONFIG_DIR that env(h) already sets. Returns the path.
 * keyokuCmd: full {command, args, env} override for drift/negative tests.
 */
export function writeClaudeJson(h, { keyokuCmd } = {}) {
  mkdirSync(h.config, { recursive: true });
  const spec = keyokuCmd ?? { type: 'stdio', command: process.execPath, args: [fakeKeyokuBin], env: { KEYOKU_HOME: h.keyoku } };
  const p = join(h.config, '.claude.json');
  writeFileSync(p, JSON.stringify({ mcpServers: { keyoku: spec } }, null, 2));
  return p;
}

/**
 * Newline-JSON-RPC driver over a spawned stdio server (the shape both `belay mcp` and
 * fake-keyoku speak). Returns:
 *   call(method, params?)  → Promise<full JSON-RPC response message>
 *   notify(method, params?)
 *   send(rawLine)          → write an arbitrary line (garbage-input tests)
 *   close()                → Promise<{ code, stdout, stderr }> (ends stdin, awaits exit)
 */
export function jsonRpcSession(exec, args, envOver = {}) {
  const child = spawn(exec, args, { env: { ...process.env, ...envOver }, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  let stderr = '';
  const extra = [];
  const pending = new Map();
  child.stderr.on('data', (d) => (stderr += d));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      extra.push(line);
      return;
    }
    if (m && m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else extra.push(line);
  });
  const exited = new Promise((res) => child.on('close', (code) => res(code)));
  return {
    child,
    call: (method, params = {}, timeoutMs = 5000) =>
      new Promise((resolvep, rejectp) => {
        const id = nextId++;
        const t = setTimeout(() => {
          pending.delete(id);
          rejectp(new Error(`jsonRpcSession: no response to ${method} (id ${id}) in ${timeoutMs}ms; stderr: ${stderr}`));
        }, timeoutMs);
        pending.set(id, (m) => {
          clearTimeout(t);
          resolvep(m);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
    notify: (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    send: (rawLine) => child.stdin.write(rawLine + '\n'),
    close: async () => {
      child.stdin.end();
      const code = await exited;
      return { code, stdout: extra.join('\n'), stderr };
    },
  };
}

/** Spawn `belay mcp` against this world's homes and drive it over newline JSON-RPC. */
export const mcpSession = (h) => jsonRpcSession(process.execPath, [bin, 'mcp'], env(h));

/** Spawn the fake-keyoku fixture against this world's KEYOKU_HOME. */
export const fakeKeyokuSession = (h) => jsonRpcSession(process.execPath, [fakeKeyokuBin], { KEYOKU_HOME: h.keyoku });
