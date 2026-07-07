// belay mcp — hand-rolled newline-delimited stdio JSON-RPC 2.0 MCP server
// (tokenroom pattern: readline over stdin, JSON.stringify+'\n' to stdout). Zero deps.
// Design: docs/DESIGN.md §2 (ADR-9 — composition, not proxy). Owner: agent A (round 1).
//
// ROUND-0 CONTRACT (FROZEN — fill in behavior, do not change signatures/schemas):
// - `initialize` echoes params.protocolVersion ?? PROTOCOL_VERSION, returns SERVER_INFO.
// - `tools/list` returns exactly TOOLS. Unknown tool → JSON-RPC error -32602.
// - Any other id'd request → {} (ping). Notifications ignored. Whole tools/call body in
//   try/catch → JSON-RPC error result, never a crash (ADR-4 applies to the server too).
// - Write posture: belay's MCP tools write only ~/.belay/* (atomic tmp+rename, 0700/0600)
//   and talk to keyoku ONLY through the spawned keyoku child (src/keyoku-client.mjs, ADR-10).
// - Handler wiring (signatures frozen round 0; changes go through the orchestrator):
//     belay_status       → compose.mjs  buildStatus({ session_id, cwd })
//     belay_loop_list    → compose.mjs  buildLoopList()
//     belay_loop_create  → loops.mjs    loopCreate(args)          (async)
//     belay_loop_pause   → loops.mjs    loopPause({ goal, note })
//     belay_loop_resume  → loops.mjs    loopResume({ goal })
//     belay_loop_disarm  → loops.mjs    loopDisarm({ goal })      (async)
//     belay_propose      → propose.mjs  scan() / dismiss(id)
// - Every string that re-enters model-visible text passes the ADR-7 sanitizers.

import { createInterface } from 'node:readline';
import { sanitizeText } from './util.mjs';
import { buildStatus, buildLoopList } from './compose.mjs';
import { loopCreate, loopPause, loopResume, loopDisarm } from './loops.mjs';
import { scan, dismiss } from './propose.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
// Versions this server actually speaks (all newline-delimited JSON-RPC, same framing). We
// negotiate DOWN to a supported one instead of echoing whatever the client sent (hook-F8):
// echoing an unknown future version claims framing semantics we may not implement.
export const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
export const SERVER_INFO = { name: 'belay', version: '0.4.0' }; // kept in lockstep with package.json (scaffold test asserts it)

/** The 7-tool surface — schemas are the DESIGN.md §2.2 contract, verbatim. FROZEN. */
export const TOOLS = [
  {
    name: 'belay_status',
    description:
      'One composed view: stack health, budget (attributed), focused goal + unmet criteria, loop arm/pause state, counters, and the would-block verdict the Stop hook would return right now. Every reported figure is read from state files; nothing is estimated or fabricated by belay — counters and the EXACT verdict need a session identity, so with no session_id and no session-pinned focus they come back unattributed (withheld) and the verdict is explicitly marked zero-history.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: "this session's id if known — enables exact per-account budget attribution and per-session counters" },
        cwd: { type: 'string', description: 'working directory to evaluate scope against (default: the server process cwd)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'belay_loop_create',
    description:
      "Create-and-arm an autonomous convergence loop. Either reference an existing keyoku goal or define one inline (criteria = machine-checkable probes + assertions, forwarded verbatim to keyoku's own goal_create). Belay routes all writes through keyoku's own process, focuses the goal, arms the loop, and returns the first would-block verdict. SCOPE (ADR-14): loops are SESSION-scoped by default — session_id is REQUIRED (the focus is pinned so only YOUR session is held) unless you pass scope:'global', which holds EVERY Claude Code session under the cwd subtree (an explicit opt-in; use only when conscripting sibling sessions is intended). If session_id is omitted, belay auto-detects it from $CLAUDE_CODE_SESSION_ID (ADR-26/B4); still refused if neither is present. THIS CALL IS THE CONFIRMATION that an autonomous loop should run; irreversible actions remain human-gated by the PreToolUse fall-arrest regardless.",
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'existing keyoku goal slug or id (omit when defining inline)' },
        objective: { type: 'string', description: 'inline creation: what converged looks like, one sentence' },
        criteria: {
          type: 'array',
          description:
            "inline creation: keyoku CriterionInput[] — {description, probe:{kind:command|http|mcp,…}, assert:{path?,op,value?}} — forwarded verbatim to keyoku goal_create, which validates them",
          items: { type: 'object' },
        },
        constraints: { type: 'array', items: { type: 'string' } },
        maxIterations: { type: 'number' },
        confirm_autonomous: {
          type: 'boolean',
          description:
            "REQUIRED true when `goal` references an existing goal whose autonomy is not already 'autonomous' — belay will then raise it via keyoku goal_update. Without it, non-autonomous referenced goals are refused (a loop must not silently convert a human-gated goal; ADR-2).",
        },
        scope: {
          type: 'string',
          enum: ['session', 'global'],
          description:
            "default 'session': the loop is pinned to session_id (required) and holds ONLY that session. 'global': no session pin — the Stop hook holds EVERY session under the cwd subtree until convergence (explicit opt-in; contradictory with session_id).",
        },
        session_id: {
          type: 'string',
          description:
            "the arming session's id (from the hook payload or the transcript path) — REQUIRED unless scope:'global', but auto-detected from $CLAUDE_CODE_SESSION_ID when omitted; the focus and the loop are pinned to it. An explicit value here always overrides the env auto-detect.",
        },
        cwd: { type: 'string', description: 'scope the focus to this project subtree (default: server cwd)' },
        proposal_id: { type: 'string', description: 'when arming a surfaced proposal — marks it armed in the proposal log' },
        autonomy: {
          type: 'string',
          enum: ['L0', 'L1', 'L2'],
          description:
            "declares how far the PreToolUse fall-arrest gate may go WITHOUT staging an outward action for batched human review (B6/ADR-28). Omit for today's conservative default: EVERY outward action (git push, gh writes, publishes, etc.) is staged, unchanged. 'L1': a plain, non-force git push to a branch OTHER than main/master is permitted; a gh pr create/merge/edit/delete is permitted. 'L2': additionally permits pushing to main/master. A FIXED always-gated set is NEVER permitted at any level — force pushes (--force/-f/--force-with-lease), npm publish, gh release, repo-destructive gh/repo writes, external sends (email/Slack/social), and anything spending money — these stay staged regardless of this setting.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'belay_loop_list',
    description:
      "All loop-relevant goals composed with belay's arm/pause metadata and counters: the focused goal, every active autonomous goal (armable), paused loops, and stale-converged goals (re-assess candidates).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'belay_loop_pause',
    description:
      "Pause the Stop-hook hold for one goal's loop (the session may stop freely). The PreToolUse fall-arrest stays ACTIVE while the goal remains focused — pausing the rope never pauses the arrest. State is belay-local; keyoku is untouched.",
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string' }, note: { type: 'string' } },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'belay_loop_resume',
    description:
      'Resume a paused loop. Clears the pause flag and the one-shot stale-block spend so the first stop re-demands fresh ground truth (goal_assess). Refused when the loop is not paused — each pause→resume cycle refunds at most one stale-block (ADR-15).',
    inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'], additionalProperties: false },
  },
  {
    name: 'belay_loop_disarm',
    description:
      "Fully stand down a loop: unfocus the goal via keyoku's own process (goal_unfocus) and clear belay's arm metadata. With no focused autonomous goal, both the Stop hold and the PreToolUse gate deactivate (belay returns to no-op).",
    inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'], additionalProperties: false },
  },
  {
    name: 'belay_propose',
    description:
      "Scan today's state files for loop-worthy signals (deferred work past its resume time, unfocused unconverged autonomous goals, stale-converged goals needing re-assess, budget freshly reset, keyoku's own ripe suggestions) and return proposal objects — each with evidence (exact figures + source file) and a ready-to-pass belay_loop_create argument object. Proposals are NEVER auto-armed: arming happens only via an explicit belay_loop_create call.",
    inputSchema: {
      type: 'object',
      properties: {
        dismiss: { type: 'string', description: "proposal id to dismiss (won't be re-surfaced until its underlying signal changes)" },
      },
      additionalProperties: false,
    },
  },
];

/** The frozen handler wiring map (header above). Async so a synchronous handler throw
 *  becomes a rejection the caller's catch turns into a JSON-RPC error (ADR-4). */
async function dispatch(name, args) {
  switch (name) {
    case 'belay_status':
      return buildStatus({
        session_id: typeof args.session_id === 'string' ? args.session_id : undefined,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      });
    case 'belay_loop_create':
      return loopCreate(args);
    case 'belay_loop_list':
      return buildLoopList();
    case 'belay_loop_pause':
      return loopPause({ goal: args.goal, note: args.note });
    case 'belay_loop_resume':
      return loopResume({ goal: args.goal });
    case 'belay_loop_disarm':
      return loopDisarm({ goal: args.goal });
    case 'belay_propose':
      return typeof args.dismiss === 'string' && args.dismiss ? dismiss(args.dismiss) : scan();
    /* c8 ignore next 2 — unreachable: mcpServe pre-checks the name against TOOLS */
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/**
 * Serve MCP over stdio until stdin ends. Never throws once serving (per-request
 * try/catch → JSON-RPC error); resolves on shutdown. Takes no flags in v1.
 * @returns {Promise<void>}
 */
export async function mcpServe() {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // garbage line — ignore, keep serving (ADR-4)
    }
    if (!msg || typeof msg !== 'object') return;
    const { id, method, params } = msg;
    if (id === undefined || typeof method !== 'string') return; // notifications ignored

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.has(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${sanitizeText(String(name), 64)}` } });
        return;
      }
      const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
      // Whole tools/call body caught: a bad tool call returns a JSON-RPC error, the
      // process never dies mid-session (ADR-4 applies to the server too). Handler error
      // text is sanitized before it re-enters model-visible context (ADR-7).
      dispatch(name, args).then(
        (result) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] } }),
        (e) => send({ jsonrpc: '2.0', id, error: { code: -32603, message: sanitizeText(String(e?.message ?? e), 300) } })
      );
    } else {
      send({ jsonrpc: '2.0', id, result: {} }); // ping & friends
    }
  });

  await new Promise((resolve) => rl.on('close', resolve));
}
