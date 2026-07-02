# belay

**The always-on goal loop for Claude Code — on official surfaces only.**

*In climbing, the belayer feeds rope so the climber keeps ascending and arrests the fall
if they slip.* Belay does exactly that for an agent: the **Stop hook** feeds rope (keeps
the agent working while its focused [Keyoku](../Keyoku) goal is unconverged and budget
allows), the **PreToolUse gate** is the fall-arrest (irreversible/external actions route
to the human), the **SessionStart hook** is the morning briefing (loop-worthy work
surfaced as proposals, never as actions), and **`belay mcp`** is the composed control
surface (`belay_status`, `belay_loop_*`, `belay_propose`). It **reads** two other tools'
state files — Keyoku's goals/focus/observations and
[tokenroom](https://github.com/tyejcoleman/tokenroom)'s budget — and never spawns their
processes from hooks.

> **Name:** the command/bin is `belay`; the npm package is **`belay-harness`** (the bare
> `belay` name is already taken on npm). Formerly published internally as `conductor`.

## The honest scope line

Belay **continues work within a session** and **advises across sessions**. It runs on
**official Claude Code surfaces only** — the Stop, PreToolUse, and SessionStart hooks, a
stdio MCP server, your own dotfiles, and scheduled routines *you* arm. It never launches
headless runs, never reuses or reads credentials, never calls the network, and never
burns quota outside the interactive session you are already in. **The human always
approves irreversible actions** (push, publish, external sends, destructive deletes route
to `permissionDecision: "ask"`, even under an autonomous goal — even while a loop is
paused). There is exactly **one spawn exception** (ADR-10): when you explicitly create or
disarm a loop, belay talks to keyoku through **keyoku's own registered MCP server
process** — spawned short-lived at MCP-call latency, never from a hook — and belay never
rewrites keyoku's state files itself. That's the compliance line, on purpose.

## What it does

- **Stop hook** — when the agent tries to stop while a scope-matched, focused,
  **autonomous** Keyoku goal still has unmet criteria, belay blocks the stop and
  hands back the unmet criteria (with descriptions) plus the current budget picture.
  When there is nothing to hold — no focus, human-in-the-loop autonomy, converged,
  paused loop, quota-dead, counters exhausted — it allows the stop, silently.
- **PreToolUse gate** — only while an autonomous goal is focused, irreversible/external
  actions (`git push`, `npm publish`, `gh pr merge`, `rm -rf` outside cwd, curl/wget
  writes to non-localhost, MCP send/publish tools) are routed to the **human** via
  `permissionDecision: "ask"`. Expensive spawns (Task/Agent/Workflow) are asked about
  under thin budget. Everything else passes untouched.
- **SessionStart briefing** — a <50ms pure-file scan surfaces up to 3 open loop
  *proposals* (deferred work past its resume time, unfocused autonomous goals,
  stale-converged goals, keyoku's own ripe suggestions) as `additionalContext`.
  Proposals are advisory: nothing is armed, focused, or written to keyoku by a hook,
  ever (ADR-11). Zero proposals → zero output.
- **MCP server** (`belay mcp`) — seven composed tools (below): one-call status, loop
  create/pause/resume/disarm, and the proposal list. Composition, not proxy (ADR-9):
  single-source questions stay with keyoku's and tokenroom's own MCP servers.
- **Loops** — `belay_loop_create` turns an objective plus machine-checkable criteria
  into an armed convergence loop in one confirmed call, with all keyoku writes routed
  through keyoku's own process (ADR-10).
- **No-op by default** — no focused autonomous goal means belay does nothing at all.
  It never polices normal interactive use.

## How the pieces compose

### The harness is the controller

Belay doesn't run agents. **Claude Code runs agents; belay makes Claude Code run them
like a harness-of-harnesses** — every surface is an official one:

- **Hooks enforce.** The Stop hook feeds rope: while your focused keyoku goal is
  unconverged, autonomous, and budget allows, ending the turn hands you back the unmet
  criteria instead of stopping. The PreToolUse gate is the fall-arrest:
  push/publish/send/destroy route to the human, even mid-loop, always. The SessionStart
  hook is the morning briefing: deferred work that's ready, autonomous goals nobody's
  driving, converged goals that may have drifted — surfaced as *proposals*, never as
  actions.
- **MCP informs and commands.** `belay_status` is one call for the whole loop brain:
  goal truth (keyoku's files) × budget truth (tokenroom's files) × enforcement state
  (belay's counters and verdict). `belay_loop_create` turns an objective plus
  machine-checkable probes into an armed loop — goal created and focused through
  keyoku's own process, never by rewriting its files. Ground truth stays where it
  lives: `goal_assess` is keyoku's; `fit_check`/`handoff` are tokenroom's; belay
  composes, it doesn't proxy.
- **The statusline shows.** tokenroom's HUD carries the budget countdowns and reset
  clocks the loop's descent decisions are made from.
- **Schedules wake.** You (the user) arm official scheduled routines — `/schedule`, or
  your own cron that opens a session. When the session starts, belay's proposals are
  waiting in context; the model arms what's in scope with an explicit
  `belay_loop_create`, and the same rope-and-arrest rules apply from the first tool
  call. Belay itself never schedules or spawns a session.

One brain, three truths: **keyoku decides what "done" means, tokenroom decides what you
can afford, belay decides whether the harness keeps climbing** — and the human keeps the
veto on everything irreversible.

## Quick start — zero to an armed autonomous loop

The stack has three legs: **tokenroom** (resource awareness), **keyoku** (goal
convergence MCP), and **belay** (this Stop + PreToolUse + SessionStart loop). One
command wires them:

```sh
git clone <this repo> && cd belay
node bin/belay.mjs bundle          # wire the whole stack (see `bundle --dry-run` to preview)
node bin/belay.mjs doctor          # one health view of all three legs
```

`belay bundle` (a) detects tokenroom (via `--tokenroom <path>`, `$TOKENROOM_BIN`, or
`which tokenroom`) and runs **its** installer — or prints "install tokenroom first" and
continues; (b) verifies the **keyoku** MCP server is registered in `.claude.json`
(read-only — belay never modifies or restarts keyoku); (c) installs belay's own Stop +
PreToolUse + SessionStart hooks **additively** (tokenroom's and every other hook
preserved) and registers the belay MCP server via `claude mcp add` (skip with
`--no-mcp`), refusing the npx cache and never duplicating on re-run. It is idempotent —
re-run it any time.

Then **arm a loop**, either way:

**One call (recommended).** From any session, call the `belay_loop_create` MCP tool with
an objective and machine-checkable criteria (each criterion is a probe — shell / HTTP /
MCP call — plus an assertion over its output, forwarded verbatim to keyoku, which
validates them):

```
belay_loop_create({
  objective: "ship the widget",
  criteria: [{ description: "tests green",
               probe: { kind: "command", command: "npm test" },
               assert: { op: "eq", value: 0 } }],
  session_id: "<this session>", cwd: "<this project>"
})
```

Belay creates the goal through keyoku's own process (autonomy `autonomous`), focuses it
scoped to your session/cwd, arms the loop, and returns the first would-block verdict.
That explicit call **is** the confirmation an autonomous loop should run — and the
fall-arrest keeps gating irreversibles regardless. (CLI equivalent:
`belay loop create --objective "…" --criteria '[…]'`.)

**By hand (all in Keyoku).** `goal_create` with machine-checkable criteria →
`goal_focus` → set autonomy to `autonomous` → `belay doctor` to confirm the legs are
green. A goal focused by hand gets the exact same loop: arming via belay is provenance
and counter-reset, not a precondition.

Now just work. When you try to end the turn with a criterion still unmet, belay's Stop
hook hands the unmet criteria back and keeps you going; when `goal_assess` reports
convergence (or the budget/continuation floor is hit), it lets you stop. Irreversible or
external actions (push, publish, sends) still pause for your approval the whole time.

Prefer to wire belay alone (tokenroom/keyoku already set up)? `node bin/belay.mjs install`
registers the three hooks + the MCP server; `uninstall` removes only belay's entries.

## Loops

What a loop **is** lives entirely in keyoku (`goals.json` + `focus.json` — criteria,
convergence, focus scope). Belay stores only what keyoku has no concept of, in
`~/.belay/loops.json`: armed-by provenance, pause state, and its continuation counters.

- **Create** (`belay_loop_create` / `belay loop create`) — reference an existing keyoku
  goal by slug/id, or define one inline; inline criteria are forwarded **verbatim** to
  keyoku's `goal_create` (keyoku is the single validator). Referencing an existing goal
  whose autonomy is not `autonomous` requires `confirm_autonomous: true` — belay never
  silently converts a human-gated goal (ADR-2), and it never un-blocks a `blocked` goal.
- **Pause** (`belay_loop_pause`) — suspends **the rope only**: the session may stop
  freely, but while the goal remains focused the PreToolUse fall-arrest stays ACTIVE
  (ADR-12). Pausing is belay-local; keyoku is untouched. There is no state with
  hold-on/arrest-off, and no loop machinery can disable the gate.
- **Resume** (`belay_loop_resume`) — clears the pause flag AND the one-shot stale-block
  spend, so the first stop re-demands fresh ground truth (`goal_assess`). A loop never
  resumes onto stale truth.
- **Disarm** (`belay_loop_disarm`) — unfocuses the goal through keyoku's own process
  (`goal_unfocus`, only when the focus actually points at that goal) and clears the arm
  metadata. With no focused autonomous goal, both the Stop hold and the PreToolUse gate
  deactivate — belay returns to no-op.
- **Bounded, always** (ADR-6) — every loop ends at convergence, keyoku's iteration
  budget, the budget floor, or belay's own `max_continuations` cap, whichever comes
  first.

### Proposals — self-proposed, never self-armed (ADR-11)

`belay propose` / `belay_propose` (and the SessionStart briefing) scan today's state
files for loop-worthy signals. Each proposal carries evidence (exact figures + source
file) and a ready-to-pass `belay_loop_create` argument object:

| Kind | Signal (pure file reads) |
|---|---|
| `resume-ready` | tokenroom `resume.json` deferred work whose `resume_at` has passed (criteria left as placeholders — belay never invents machine checks) |
| `unfocused-autonomous` | active `autonomous` goals in `goals.json` that nobody is driving |
| `stale-converged` | converged goals not re-assessed in `stale_converged_days` — suggests a **direct `goal_assess`**, not a loop (assess is free) |
| `budget-reset` | the 5h window just refilled / ≥85% left — an *amplifier* attached to paused-loop and resume-ready proposals |
| `keyoku-ripe` | keyoku's own background ripeness suggestions (`ripe.json`), advisory |

Proposals are **never** auto-armed: arming happens only through an explicit
`belay_loop_create` call (its `proposal_id` marks the proposal armed, and `armed_by:
"proposal:<id>"` is recorded — auditable via `belay_loop_list`). Dismissals are durable:
ids are content hashes, so a persisting signal keeps its id and a dismissed one stays
dismissed until the signal itself changes.

## MCP tools (`belay mcp`)

Registered by `belay install` as a stdio server. **Composition, not proxy** (ADR-9):
belay's tools exist only where the answer needs goal truth × budget truth × enforcement
state composed, or where a write must be orchestrated. Single-source questions stay
direct calls to the existing servers — `goal_assess`/`goal_record`/`goal_get` are
keyoku's; `checkpoint`/`handoff`/`fit_check`/`plan_resume` are tokenroom's.

| Tool | What it answers/does |
|---|---|
| `belay_status` | One composed view: stack health, attributed budget, focused goal + unmet criteria, loop arm/pause state, counters, and the exact would-block verdict the Stop hook would return right now. Every figure is read from a state file. With ≥2 accounts active and no `session_id`, quota figures are **withheld** with an explanation — wrong-account numbers are worse than none. |
| `belay_loop_create` | Objective (or existing goal) → armed loop, one confirmed call. All keyoku writes via keyoku's own process. |
| `belay_loop_list` | Every loop-relevant goal × arm/pause metadata × counters (focused, armable, paused, stale-converged). |
| `belay_loop_pause` | Release the Stop hold for one goal; the fall-arrest stays active (ADR-12). |
| `belay_loop_resume` | Re-arm; first stop re-demands a fresh `goal_assess`. |
| `belay_loop_disarm` | Unfocus via keyoku + clear arm state; belay returns to no-op. |
| `belay_propose` | The proposal list with evidence + ready-to-arm args; `dismiss` an id durably. |

## Decision table

### Stop hook (`belay hook stop`)

| # | Condition (checked in order) | Decision |
|---|---|---|
| 1 | `stop_hook_active` (any value) | **not consulted** — belay substitutes its OWN bounded budget for the harness guard (ADR-6): every stop is evaluated, and its monotonic per-(session, goal) counter guarantees termination without depending on the flag. |
| 2 | keyoku home absent, or `paused` marker present | **allow**, silent |
| 3 | no/unreadable `focus.json`, focused goal missing from `goals.json` | **allow**, silent |
| 4 | scope mismatch (focus `sessionId` differs; or the **session cwd is not inside** the focus `cwd` subtree — one-way, ADR-5) | **allow**, silent |
| 5 | the goal's loop is **paused** (`belay_loop_pause`) | **allow** + stderr `loop-paused` note — the PreToolUse arrest stays ACTIVE while the goal remains focused (ADR-12); `belay_loop_resume` re-arms |
| 6 | goal `converged` | **allow** + stderr `goal converged — nothing to hold` |
| 7 | goal `blocked` / `abandoned` / unknown status | **allow**, silent |
| 8 | autonomy `observe` / `suggest` / `approve` | **allow**, silent (only `autonomous` goals self-continue) |
| 9 | keyoku iteration budget exhausted (`usedIterations >= maxIterations`) | **allow** + stderr note |
| 10 | budget known and below `budget_floor_pct` (3%) with **no** fresh alt profile | **allow** + stderr note (descent: quota-dead is the one legit stop) |
| 11 | assessment stale (> `stale_assess_min`, 60m — or never assessed), stale-block not yet spent | **block once**: "state is stale — run goal_assess first to get ground truth" |
| 12 | assessment stale, stale-block already spent | **allow** + stderr note |
| 13 | fresh observation with nothing unmet | **allow**, silent |
| 14 | continuations ≥ `max_continuations` (25) for this (session, goal) | **allow** + stderr note (the ADR-6 termination bound; monotonic — resets only when the focused goal changes) |
| 15 | autonomous + unmet criteria + budget above floor | **BLOCK** with unmet `id: description` list + budget line; counter++ |

Budget line in a block: healthy → `5h: X% left`; thin (<15%) → `budget thin (X% left,
resets HH:MM) — smallest atomic step, checkpoint, then defer via plan_resume if it can't
land`; a known-fresh second profile adds `profile '<label>' has ≈Y% — finishing move
here, then suggest the user switch`. Budget UNKNOWN (tokenroom absent/stale/pre-reset
data) → block carries **no** budget line (permissive for stop decisions — never invent a figure).

### PreToolUse gate (`belay hook pre-tool-use`)

| Condition | Decision |
|---|---|
| `gate_enabled: false`, or no scope-matched focused **active autonomous** goal | silent (allow) |
| `allow_overrides` pattern matches tool name or command | silent (allow) |
| Bash: `git push` · `npm publish` · `gh (pr\|release\|repo) (create\|merge\|edit\|delete)` · `rm -rf` outside cwd · curl/wget POST/PUT (or body upload) to non-localhost | **ask** — `'<class>' action under autonomous goal — requires human approval (goal constraint policy)` |
| MCP tool name matching send/publish (`mcp__*send/publish/add_message/post_message/create_draft`) | **ask** (same wording, class `external send/publish`) |
| config `ask_patterns` match (tested against tool name AND command) | **ask** with configured class/note |
| Task/Agent/Workflow while budget < `spawn_floor_pct` (10%) — fresh, **or stale last-known** (conservative) — and no fresh alt profile | **ask** — `budget descent: no new subagents below 10% — do the work inline in small steps` |
| everything else | silent (allow) |

The gate never consults loop state: no code path leads from `loops.json` to the gate
decision, so no loop machinery (arm, pause, proposal) can weaken the arrest (ADR-12).

### SessionStart briefing (`belay hook session-start`)

Runs the proposal scan (pure file reads), persists it, and — only when open proposals
exist — emits up to `proposal_max_surfaced` of them as `additionalContext`, each line
sanitized and the whole block capped ≤1.5KB (ADR-7). No keyoku write, no arm, no spawn,
ever, from a hook. Errors are silent (never-crash rule).

## Configuration — `~/.belay/config.json`

```jsonc
{
  "max_continuations": 25,       // forced continuations per (session, goal) before belay lets go; monotonic, resets on goal change (ADR-6 termination bound)
  "budget_floor_pct": 3,         // below this (no fresh alt): allow stop (descent)
  "spawn_floor_pct": 10,         // below this (no fresh alt): ask before new subagents
  "thin_budget_pct": 15,         // below this the block reason switches to descent wording
  "stale_assess_min": 60,        // observations older than this trigger the one stale-block
  "gate_enabled": true,          // PreToolUse gate master switch
  "ask_patterns": [              // extra ask classes; pattern is a JS regex (case-insensitive),
    {                            // tested against BOTH the tool name and the Bash command
      "pattern": "terraform\\s+apply",
      "class": "infra apply",
      "note": "production infra"
    }
  ],
  "allow_overrides": [],         // regexes that force-allow before any ask class
  "proposals_enabled": true,     // master switch for the proposal scan + SessionStart surfacing
  "proposal_max_surfaced": 3,    // proposals per SessionStart injection
  "stale_converged_days": 7,     // converged goals older than this become re-assess proposals
  "keyoku_call_timeout_ms": 15000 // per keyoku-child JSON-RPC call (ADR-10)
}
```

Every field is optional and validated defensively: a bad field falls back to its default
and `belay doctor` reports the warning. Bad config never crashes a hook.

## What it reads (and what it writes)

| Source | Files | Direction |
|---|---|---|
| Keyoku (`$KEYOKU_HOME` \|\| `~/.keyoku`) | `paused`, `focus.json`, `goals.json`, `observations/<goalId>.jsonl`, `ripe.json` | read-only from files, pinned to keyoku >=2.7 <3, layout self-checked by `belay doctor`. Never runs probes; never rewrites goals/focus. Writes go ONLY through keyoku's own registered server process, spawned per explicit loop create/disarm call (ADR-10) — never from hooks. |
| tokenroom (`$TOKENROOM_DIR` \|\| `~/.tokenroom`) | `state.json`, `accounts/<key>/state.json`, `sessions.json`, `profiles.json`, `resume.json` | read-only. >30min old → budget UNKNOWN. |
| belay (`$BELAY_DIR` \|\| `~/.belay`) | `state.json` (continuation counters), `config.json`, `loops.json` (arm/pause provenance), `proposals.json` | its own state only; dirs 0700, files 0600, atomic writes. No goal data is copied beyond the goalId key. |

## CLI

```
belay bundle [--dry-run] [--config-dir <dir>] [--tokenroom <path>]   wire the whole stack (tokenroom + keyoku + belay)
belay install [--dry-run] [--config-dir <dir>] [--no-mcp]   register the Stop + PreToolUse + SessionStart hooks + the MCP server (additive)
belay uninstall [--config-dir <dir>]             remove only belay's entries
belay status      # focused goal + loop arm/pause + would-block verdict + counters + open proposals
belay doctor      # full-stack health: keyoku layout + version pin, tokenroom, hooks, MCP registration, loops/proposals state, config
belay mcp         # stdio MCP server (belay_status, belay_loop_*, belay_propose) — registered by install
belay loop create [--goal <slug|id>] [--objective <text> --criteria <json>]
                  [--constraints <json>] [--max-iterations <n>] [--confirm-autonomous]
                  [--session-id <id>] [--cwd <dir>] [--proposal-id <id>]
belay loop list                            loop-relevant goals × arm/pause state × counters
belay loop pause <goal> [--note <text>]    pause the Stop hold (the fall-arrest gate stays active)
belay loop resume <goal>                   resume (re-demands a fresh goal_assess)
belay loop disarm <goal>                   unfocus via keyoku + clear arm state
belay propose [--dismiss <id>]             scan for loop-worthy signals; advisory, never auto-armed
belay hook <stop|pre-tool-use|session-start>   # wired by install
```

## Development

Zero dependencies, plain ESM, `node:test`. `npm test` spawns the real bin against
synthetic `KEYOKU_HOME`/`TOKENROOM_DIR`/`BELAY_DIR`/`CLAUDE_CONFIG_DIR` fixtures for
every decision branch, drives `belay mcp` over newline stdio JSON-RPC, and exercises the
keyoku write path against a fake-keyoku fixture server
(`test/fixtures/fake-keyoku.mjs`). See `docs/DECISIONS.md` for the ADR log and
`docs/DESIGN.md` for the SOTA loop design.

License: Apache-2.0
