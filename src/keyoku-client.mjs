import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readJSON, readConfig, sanitizeText } from './util.mjs';
import { claudeJsonPath } from './stack.mjs';

// The ONLY keyoku write path (ADR-10): spawn the ~/.claude.json-REGISTERED keyoku server
// command as a short-lived stdio JSON-RPC child, at MCP-call latency only — NEVER at hook
// latency, NEVER by rewriting keyoku's files (goals.json is a whole-array clobber risk;
// keyoku's cacheless read-modify-write store is the concurrency license, store.ts:65-73).
// Design: docs/DESIGN.md §2.4. Owner: agent B (round 1).
//
// ROUND-0 CONTRACT (FROZEN):
// - Resolve the registered spec {command, args, env} verbatim from ~/.claude.json (reuse
//   stack.mjs allMcpServers/claudeJsonPath — $CLAUDE_JSON/$CLAUDE_CONFIG_DIR overrides work
//   in tests); fallback $KEYOKU_INSTALL/dist/index.js; not found → { ok:false, error }.
// - Child env: pass the registered env through verbatim, but NEVER log/echo env in errors.
//   Child stderr/stdout CONTENT is withheld from surfaced errors entirely (refute L2-3):
//   a crashing server can echo its env (provider SDKs put keys in request URLs; DEBUG
//   dumps env), and format-only sanitization cannot redact secrets — so transport errors
//   carry only belay-authored text. Diagnose child failures from keyoku's own logs.
// - Session: initialize → notifications/initialized → tools/call per step → close stdin
//   (keyoku's serve() shuts down on stdin end). One child per belay_loop_create/disarm
//   call; hard timeout per call (cfg.keyoku_call_timeout_ms, default 15000) — child KILLED
//   on timeout, error result returned (never a crash, ADR-4).
// - Parse keyoku's result.content[0].text as JSON; keyoku's own validation errors return
//   verbatim (keyoku is the single validator — belay never re-validates criteria).
// - Windows: the registered command is spawned as-is (`node` resolves via PATH the same
//   way Claude Code resolves it when IT spawns the server) — no where/which probing needed
//   because we never guess a binary, we replay the registration verbatim.

/** The mcpServers walk stack.mjs uses internally (allMcpServers is module-private there;
 *  same claudeJsonPath, same top-level + per-project descent — keep the two in step). */
function registeredMcpServers() {
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

/**
 * Resolve the registered keyoku MCP server spec — read-only, never throws.
 * @returns {{ ok: true, command: string, args: string[], env: object, source: string }
 *          | { ok: false, error: string }}
 */
export function resolveKeyokuServer() {
  for (const [name, s] of registeredMcpServers()) {
    if (!/keyoku/i.test(name)) continue;
    if (!s || typeof s !== 'object' || typeof s.command !== 'string' || !s.command) continue;
    return {
      ok: true,
      command: s.command, // verbatim — this is the exact process Claude Code itself speaks to
      args: Array.isArray(s.args) ? s.args.filter((a) => typeof a === 'string') : [],
      env: s.env && typeof s.env === 'object' && !Array.isArray(s.env) ? s.env : {},
      source: claudeJsonPath(),
    };
  }
  if (process.env.KEYOKU_INSTALL) {
    const entry = join(process.env.KEYOKU_INSTALL, 'dist', 'index.js');
    if (existsSync(entry)) return { ok: true, command: process.execPath, args: [entry], env: {}, source: 'KEYOKU_INSTALL' };
  }
  return { ok: false, error: 'keyoku MCP server not registered' };
}

/** Error text for keyoku PROTOCOL messages and OS spawn errors only — NEVER child
 *  stderr/stdout content (see the L2-3 note in the header: the registered env can be
 *  echoed there, and these messages land in the model-visible transcript). */
const errText = (prefix, detail) => `${prefix}${detail ? `: ${sanitizeText(String(detail), 300)}` : ''}`;
const STDERR_WITHHELD = 'child stderr is withheld from errors (it can carry the registered env) — check keyoku\'s own logs';

/**
 * Open one short-lived JSON-RPC session against the registered keyoku server.
 * `call` resolves with the parsed result.content[0].text JSON (or rejects with a
 * sanitized error on timeout/kill/parse failure); `close` ends stdin and awaits exit.
 * Callers make ALL their tools/call steps on one child, then close.
 *
 * @param {{ timeoutMs?: number }} [opts] per-call hard timeout (default cfg.keyoku_call_timeout_ms)
 * @returns {Promise<{ call: (tool: string, args?: object) => Promise<object>,
 *                     close: () => Promise<void> }>}
 */
export async function keyokuSession({ timeoutMs } = {}) {
  const spec = resolveKeyokuServer();
  if (!spec.ok) throw new Error(spec.error);
  const { cfg } = readConfig();
  const perCall = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : cfg.keyoku_call_timeout_ms;

  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env }, // registered env passes through verbatim (ADR-10) — and never into any error text
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let exited = false;
  const pending = new Map(); // id → { resolve, reject, timer }
  child.stderr.resume(); // drain so the child never blocks on a full pipe — content is NEVER kept or surfaced (L2-3)

  const failAll = (msg) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new Error(msg));
    }
  };
  const exitPromise = new Promise((res) => {
    child.on('close', (code) => {
      exited = true;
      failAll(`keyoku child exited (code ${code}) before responding — ${STDERR_WITHHELD}`);
      res(code);
    });
  });
  child.on('error', (e) => {
    exited = true;
    failAll(errText('keyoku child failed to spawn', e?.message)); // spawn errors carry no env
  });
  child.stdin.on('error', () => {}); // EPIPE after kill — the pending rejection already told the story

  createInterface({ input: child.stdout }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout — ignore, keep the session alive
    }
    const p = m && m.id !== undefined ? pending.get(m.id) : undefined;
    if (!p) return; // notification / unsolicited — ignore
    clearTimeout(p.timer);
    pending.delete(m.id);
    p.resolve(m);
  });

  /** One JSON-RPC request → full response message; timeout KILLS the child (hard stop). */
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      if (exited) return reject(new Error(`keyoku child already exited — ${STDERR_WITHHELD}`));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(new Error(`keyoku ${method} timed out after ${perCall}ms (child killed) — ${STDERR_WITHHELD}`));
      }, perCall);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  // Handshake per ADR-10: initialize → notifications/initialized. A dead/hung server
  // surfaces HERE (sanitized reject, child killed) — never as a wedged tool call.
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'belay', version: '0.1.0' } });
  } catch (e) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    throw e;
  }
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  return {
    /** tools/call → parsed result.content[0].text JSON. Keyoku's own validation errors come
     *  back as a parsed `{ error }` object VERBATIM (single validator, no drift); transport/
     *  protocol failures reject with a sanitized Error. */
    call: async (tool, args = {}) => {
      const m = await rpc('tools/call', { name: tool, arguments: args });
      if (m.error) throw new Error(errText(`keyoku ${tool} failed`, m.error.message));
      const text = m.result?.content?.[0]?.text;
      if (typeof text !== 'string') throw new Error(`keyoku ${tool} returned no content — ${STDERR_WITHHELD}`);
      try {
        return JSON.parse(text);
      } catch {
        // raw child output withheld for the same reason as stderr (L2-3)
        throw new Error(`keyoku ${tool} returned unparseable JSON (${Buffer.byteLength(text, 'utf8')} bytes — content withheld, it can carry the registered env)`);
      }
    },
    /** End stdin (keyoku's serve() shuts down on stdin end) and await exit; a child that
     *  lingers past 5s is killed — close() never hangs the caller. */
    close: async () => {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      if (!exited) {
        const grace = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 5000);
        await exitPromise;
        clearTimeout(grace);
      }
    },
  };
}
