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

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'belay', version: '0.1.0' };

/** The 7-tool surface — schemas are the DESIGN.md §2.2 contract, verbatim. FROZEN. */
export const TOOLS = [
  {
    name: 'belay_status',
    description:
      'One composed view: stack health, budget (attributed), focused goal + unmet criteria, loop arm/pause state, counters, and the exact would-block verdict the Stop hook would return right now. Every figure is read from state files; nothing is estimated by belay.',
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
      "Create-and-arm an autonomous convergence loop. Either reference an existing keyoku goal or define one inline (criteria = machine-checkable probes + assertions, forwarded verbatim to keyoku's own goal_create). Belay routes all writes through keyoku's own process, focuses the goal scoped to this session/cwd, arms the loop, and returns the first would-block verdict. THIS CALL IS THE CONFIRMATION that an autonomous loop should run; irreversible actions remain human-gated by the PreToolUse fall-arrest regardless.",
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
        session_id: { type: 'string', description: 'scope the focus (and the loop) to this session' },
        cwd: { type: 'string', description: 'scope the focus to this project subtree (default: server cwd)' },
        proposal_id: { type: 'string', description: 'when arming a surfaced proposal — marks it armed in the proposal log' },
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
      'Resume a paused loop. Clears the pause flag and the one-shot stale-block spend so the first stop re-demands fresh ground truth (goal_assess).',
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

const notImplemented = (fn) => Object.assign(new Error(`belay: ${fn} not implemented (round-0 stub — see docs/DESIGN.md)`), { code: 'ERR_NOT_IMPLEMENTED' });

/**
 * Serve MCP over stdio until stdin ends. Never throws once serving (per-request
 * try/catch → JSON-RPC error); resolves on shutdown.
 * @param {string[]} [argv] raw CLI args after the verb (reserved; no flags in v1)
 * @returns {Promise<void>}
 */
export async function mcpServe(argv = []) {
  throw notImplemented('mcpServe');
}
