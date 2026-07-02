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
// - Child env: pass the registered env through verbatim, but NEVER log/echo env in errors;
//   sanitize child stderr (ADR-7 sanitizeText) before surfacing anywhere.
// - Session: initialize → notifications/initialized → tools/call per step → close stdin
//   (keyoku's serve() shuts down on stdin end). One child per belay_loop_create/disarm
//   call; hard timeout per call (cfg.keyoku_call_timeout_ms, default 15000) — child KILLED
//   on timeout, error result returned (never a crash, ADR-4).
// - Parse keyoku's result.content[0].text as JSON; keyoku's own validation errors return
//   verbatim (keyoku is the single validator — belay never re-validates criteria).
// - Windows: mirror stack.mjs resolveTokenroom's where/which handling where relevant.

const notImplemented = (fn) => Object.assign(new Error(`belay: ${fn} not implemented (round-0 stub — see docs/DESIGN.md)`), { code: 'ERR_NOT_IMPLEMENTED' });

/**
 * Resolve the registered keyoku MCP server spec — read-only, never throws.
 * @returns {{ ok: true, command: string, args: string[], env: object, source: string }
 *          | { ok: false, error: string }}
 */
export function resolveKeyokuServer() {
  throw notImplemented('resolveKeyokuServer');
}

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
  throw notImplemented('keyokuSession');
}
