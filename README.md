# conductor

**The always-on goal loop for Claude Code — on official surfaces only.**

Conductor is a Stop hook that keeps an agent working while its focused
[Keyoku](../Keyoku) goal is unconverged and budget allows, plus a PreToolUse policy gate
(autonomy × budget × action-class). It **reads** two other tools' state files —
Keyoku's goals/focus/observations and [tokenroom](https://github.com/tyejcoleman/tokenroom)'s
budget — and never spawns their processes from hooks.

> npm name note: `conductor-harness` in package.json is a **placeholder** — the final
> npm name is TBD and the package stays `private: true` until it is named.

## The honest scope line

Conductor **continues work within a session** and **advises across sessions**. It never
launches headless runs, never reuses credentials, never calls the network, and never
burns quota outside the interactive session you are already in. When the session ends,
conductor's job ends; the most it does for "later" is wording in a block reason
(checkpoint, `plan_resume`, "suggest the user switch profiles"). That's the compliance
line, on purpose.

## What it does

- **Stop hook** — when the agent tries to stop while a scope-matched, focused,
  **autonomous** Keyoku goal still has unmet criteria, conductor blocks the stop and
  hands back the unmet criteria (with descriptions) plus the current budget picture.
  When there is nothing to hold — no focus, human-in-the-loop autonomy, converged,
  quota-dead, counters exhausted — it allows the stop, silently.
- **PreToolUse gate** — only while an autonomous goal is focused, irreversible/external
  actions (`git push`, `npm publish`, `gh pr merge`, `rm -rf` outside cwd, curl/wget
  writes to non-localhost, MCP send/publish tools) are routed to the **human** via
  `permissionDecision: "ask"`. Expensive spawns (Task/Agent/Workflow) are asked about
  under thin budget. Everything else passes untouched.
- **No-op by default** — no focused autonomous goal means conductor does nothing at all.
  It never polices normal interactive use.

## Install

```sh
git clone <this repo> && cd conductor
node bin/conductor.mjs install     # registers Stop + PreToolUse hooks (additive; backs up settings.json)
node bin/conductor.mjs doctor      # verifies keyoku layout, tokenroom presence, hook registration, config
```

`install` preserves every existing hook (tokenroom's included), never duplicates on
re-run, and refuses to install from the npx cache (evictable paths). `uninstall`
removes only conductor's entries.

## Decision table

### Stop hook (`conductor hook stop`)

| # | Condition (checked in order) | Decision |
|---|---|---|
| 1 | `stop_hook_active === true` | **allow** (Claude Code's own loop guard — always respected) |
| 2 | keyoku home absent, or `paused` marker present | **allow**, silent |
| 3 | no/unreadable `focus.json`, focused goal missing from `goals.json` | **allow**, silent |
| 4 | scope mismatch (focus `sessionId` differs; or the **session cwd is not inside** the focus `cwd` subtree — one-way, ADR-5) | **allow**, silent |
| 5 | goal `converged` | **allow** + stderr `goal converged — nothing to hold` |
| 6 | goal `blocked` / `abandoned` / unknown status | **allow**, silent |
| 7 | autonomy `observe` / `suggest` / `approve` | **allow**, silent (only `autonomous` goals self-continue) |
| 8 | keyoku iteration budget exhausted (`usedIterations >= maxIterations`) | **allow** + stderr note |
| 9 | budget known and below `budget_floor_pct` (3%) with **no** fresh alt profile | **allow** + stderr note (descent: quota-dead is the one legit stop) |
| 10 | assessment stale (> `stale_assess_min`, 60m — or never assessed), stale-block not yet spent | **block once**: "state is stale — run goal_assess first to get ground truth" |
| 11 | assessment stale, stale-block already spent | **allow** + stderr note |
| 12 | fresh observation with nothing unmet | **allow**, silent |
| 13 | continuations ≥ `max_continuations` (25) for this (session, goal) | **allow** + stderr note |
| 14 | autonomous + unmet criteria + budget above floor | **BLOCK** with unmet `id: description` list + budget line; counter++ |

Budget line in a block: healthy → `5h: X% left`; thin (<15%) → `budget thin (X% left,
resets HH:MM) — smallest atomic step, checkpoint, then defer via plan_resume if it can't
land`; a known-fresh second profile adds `profile '<label>' has ≈Y% — finishing move
here, then suggest the user switch`. Budget UNKNOWN (tokenroom absent/stale/pre-reset
data) → block carries **no** budget line (permissive for stop decisions — never invent a figure).

### PreToolUse gate (`conductor hook pre-tool-use`)

| Condition | Decision |
|---|---|
| `gate_enabled: false`, or no scope-matched focused **active autonomous** goal | silent (allow) |
| `allow_overrides` pattern matches tool name or command | silent (allow) |
| Bash: `git push` · `npm publish` · `gh (pr\|release\|repo) (create\|merge\|edit\|delete)` · `rm -rf` outside cwd · curl/wget POST/PUT (or body upload) to non-localhost | **ask** — `'<class>' action under autonomous goal — requires human approval (goal constraint policy)` |
| MCP tool name matching send/publish (`mcp__*send/publish/add_message/post_message/create_draft`) | **ask** (same wording, class `external send/publish`) |
| config `ask_patterns` match (tested against tool name AND command) | **ask** with configured class/note |
| Task/Agent/Workflow while budget < `spawn_floor_pct` (10%) — fresh, **or stale last-known** (conservative) — and no fresh alt profile | **ask** — `budget descent: no new subagents below 10% — do the work inline in small steps` |
| everything else | silent (allow) |

## Configuration — `~/.conductor/config.json`

```jsonc
{
  "max_continuations": 25,     // per (session, goal) stop-blocks before conductor lets go
  "budget_floor_pct": 3,       // below this (no fresh alt): allow stop (descent)
  "spawn_floor_pct": 10,       // below this (no fresh alt): ask before new subagents
  "thin_budget_pct": 15,       // below this the block reason switches to descent wording
  "stale_assess_min": 60,      // observations older than this trigger the one stale-block
  "gate_enabled": true,        // PreToolUse gate master switch
  "ask_patterns": [            // extra ask classes; pattern is a JS regex (case-insensitive),
    {                          // tested against BOTH the tool name and the Bash command
      "pattern": "terraform\\s+apply",
      "class": "infra apply",
      "note": "production infra"
    }
  ],
  "allow_overrides": []        // regexes that force-allow before any ask class
}
```

Every field is optional and validated defensively: a bad field falls back to its default
and `conductor doctor` reports the warning. Bad config never crashes a hook.

## What it reads (and never writes)

| Source | Files | Direction |
|---|---|---|
| Keyoku (`$KEYOKU_HOME` \|\| `~/.keyoku`) | `paused`, `focus.json`, `goals.json`, `observations/<goalId>.jsonl` | read-only, pinned to keyoku >=2.7 <3, layout self-checked by `conductor doctor`. Never runs probes; never rewrites goals/focus. |
| tokenroom (`$TOKENROOM_DIR` \|\| `~/.tokenroom`) | `state.json`, `accounts/<key>/state.json`, `sessions.json`, `profiles.json` | read-only. >30min old → budget UNKNOWN. |
| conductor (`$CONDUCTOR_DIR` \|\| `~/.conductor`) | `state.json` (continuation counters), `config.json` | its own state only; dirs 0700, files 0600, atomic writes. |

## CLI

```
conductor install [--dry-run] [--config-dir <dir>]
conductor uninstall [--config-dir <dir>]
conductor status      # focused goal + would-block verdict + counters
conductor doctor      # keyoku layout self-check, version pin, tokenroom, hooks, config
conductor hook <stop|pre-tool-use>   # wired by install
```

## Development

Zero dependencies, plain ESM, `node:test`. `npm test` spawns the real bin against
synthetic `KEYOKU_HOME`/`TOKENROOM_DIR`/`CONDUCTOR_DIR` fixtures for every decision
branch. See `docs/DECISIONS.md` for the ADR log.

License: Apache-2.0
