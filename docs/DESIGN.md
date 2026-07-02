# Belay SOTA Upgrade — Design: `belay mcp` + loop creation + self-proposing loops
**Date:** 2026-07-02 · **Status:** DESIGN (pre-build) · **Repo:** /Users/taikicoleman/Development/conductor
**Mission:** belay becomes the single meta-harness: MCP-accessible from Claude Code, able to RUN and CREATE autonomous loops, with the Claude Code harness as the controller. Official surfaces only.

---

## 0. Invariants this design preserves (hard constraints, verified against source)

1. **Zero runtime deps.** MCP server is hand-rolled newline-delimited stdio JSON-RPC 2.0, copied from tokenroom's proven pattern (`/Users/taikicoleman/Development/tokenroom/src/mcp.mjs` — `createInterface(stdin)`, `initialize`/`tools/list`/`tools/call`, notifications ignored). Keyoku's own server uses the MCP SDK `StdioServerTransport`, which is also newline-delimited JSON-RPC — so a hand-rolled *client* speaks to it natively.
2. **Official Claude Code surfaces only** (ADR-22 lineage, not re-litigated): Stop hook, PreToolUse hook, **+ SessionStart hook** (already an official tokenroom surface: `tokenroom/src/hook.mjs:309-335` emits `hookSpecificOutput.additionalContext`), MCP stdio server, user dotfiles, and user-armed scheduled routines (`/schedule`). No headless session spawning, ever. Loops execute inside live sessions via Stop-hook continuation.
3. **Fall-arrest preserved.** The PreToolUse gate condition is untouched: active while any scope-matched focused **active autonomous** goal exists (`src/gate.mjs decideGate`). Nothing in this design can weaken it — see §3.4 (pause pauses the *rope*, never the *arrest*).
4. **Keyoku writes only via keyoku's own process** — and only at MCP-call latency, never hook latency (tokenroom `ORCHESTRATION.md:115,117`: CLI spawn 160–264ms vs hook file-reads ≈44ms; NEVER rewrite goals.json/focus.json externally). Mechanism: §2.4. Keyoku's `Store` is explicitly **cacheless** and designed for concurrent processes (`keyoku-harness/src/store.ts:65-73`: "every read goes to disk so long-running processes … always see each other's writes. Mutations are read-modify-write over the freshest copy" → last-writer-wins *per entry*, not destructive), so a short-lived second keyoku process is a supported write path.
5. **Every reported figure comes from a state file or a spawned tool.** Every MCP response field in §2 has an exact data source; budget-unknown stays unknown (`readBudget` semantics, never invented — README "Budget UNKNOWN … never invent a figure").
6. **ADR-2/3/4/5/6/7 all stand.** New behavior degrades to today's behavior when the new files are absent (§3.2).

---

## 1. Research base (facts the design leans on)

| Fact | Source |
|---|---|
| Stop decision table + `decideStop` pure function, one-shot stale/unmet-unknown blocks, monotonic counters | `conductor/src/stop.mjs`, `docs/DECISIONS.md` ADR-6/7 |
| Gate classes (git push / npm publish / gh mutations / rm -rf outside cwd / network write / mcp send) → `ask` | `conductor/src/gate.mjs`, ADR-3 |
| Keyoku file contract: `focus.json` {goalId, goalSlug?, cwd?, sessionId?, at} global singleton; `goals.json` whole-array; `observations/<goalId>.jsonl` tail `{unmet:[ids], summary, at}`; `paused` marker | `conductor/src/keyoku.mjs`, tokenroom `ORCHESTRATION.md:110-117` |
| Goal row fields (live-verified, 38 goals): `id, slug, objective, criteria[{id,description,probe,assert}], constraints, autonomy, maxIterations, usedIterations, status, createdAt, updatedAt, convergedAt, lastAssessedAt` | live `~/.keyoku/goals.json` + `keyoku-harness/src/types.ts:156-171` |
| Keyoku MCP tools: goal_create/list/get/update/delete/assess/converge/guardrails/run/record/focus/unfocus + connector_* + workflow_* + approvals + knowledge + activity + harness_* | `keyoku-harness/src/server.ts` |
| `goal_focus` accepts `{goal, cwd?, sessionId?}`; `goal_update` accepts `{autonomy, status, maxIterations…}`; `goal_create` accepts `{objective, slug?, criteria[CriterionInput], constraints?, autonomy?, maxIterations?}` with probe kinds `command|http|mcp` + JMESPath assertions | `server.ts:179-500`, `types.ts:14-148` |
| Keyoku CLI verbs incl. `focus <slug>|--clear`, `pause`, `resume`, `record` (stdin), `serve` (default) — **no CLI goal-create** → creation must go through the MCP server surface | `keyoku-harness/src/index.ts:1507-1574` |
| Keyoku registration (live): `~/.claude.json` `mcpServers.keyoku = {type:"stdio", command:"node", args:["…/keyoku-harness/dist/index.js"], env:{…}}` — belay already parses this (`src/stack.mjs allMcpServers/claudeJsonPath`, `$CLAUDE_JSON` test override) | `~/.claude.json`, `conductor/src/stack.mjs:22-47` |
| Keyoku background nudges: serve loop caches ripeness to `~/.keyoku/ripe.json` (`{at, suggestions[]}`) + `surfaced.json` dedupe | `keyoku-harness/src/index.ts:110-125`, live files |
| tokenroom resume plan: `~/.tokenroom/resume.json` `{summary(≤500), est_tokens, created_at, resume_at}`; invalid/24h-old → null; `resume_at` = five_hour resets_at at plan time | `tokenroom/src/resume.mjs` + live file |
| tokenroom state: `state.json` ResourceState v0 (windows.five_hour.used_pct/resets_at, burn.est_tokens_left, context.*, session.cost_usd, account_key); `accounts/<key>/state.json` same shape; `sessions.json` {sid:{key,at}}; `profiles.json` {profiles:{label:{keys[], last_seen, last_windows_snapshot}}} | live `~/.tokenroom/*`, `conductor/src/budget.mjs` |
| tokenroom MCP-attribution rule (ADR-24): MCP calls carry no session id → 1 active account in last 10min = use it; ≥2 = **withhold quota** with explicit `attribution` note | `tokenroom/src/mcp.mjs:113-142` |
| tokenroom installer registers its MCP via official CLI: `claude mcp add --scope user tokenroom <node> <bin> mcp`, with printed manual fallback | `tokenroom/src/install.mjs:180-201` |
| SessionStart `additionalContext` is the official injection channel | `tokenroom/src/hook.mjs:310-335`; live settings.json has a SessionStart hook array |

---

## 2. (a) `belay mcp` — the server

### 2.1 Transport + registration
- New bin verb: `belay mcp` → `src/mcp.mjs mcpServe()`. Hand-rolled, tokenroom-pattern: readline over stdin, `JSON.stringify + '\n'` to stdout, `initialize` echoes `params.protocolVersion ?? '2025-06-18'`, `tools/list`, `tools/call`, unknown tool → `-32602`, any other id'd request → `{}` (ping), notifications ignored. Whole `tools/call` body in try/catch → JSON-RPC error, never a crash (ADR-4 applies to the server too: a bad tool call returns an error *result*, the process never dies mid-session).
- `belay install` gains an MCP registration step mirroring tokenroom's: `claude mcp add --scope user belay "<process.execPath>" "<abs bin/belay.mjs>" mcp` (skip with `--no-mcp` / `--config-dir` sandbox; print the manual command when the `claude` CLI is unavailable). `belay uninstall` runs `claude mcp remove`. npx-cache refusal already exists and covers this path.
- **Server-side write posture:** belay's MCP tools write only `~/.belay/*` (atomic tmp+rename, 0700/0600 — existing `util.mjs ensureDir/atomicWriteJSON`) and talk to keyoku **only** through the spawned keyoku process (§2.4). Belay still never runs probes and never touches `~/.keyoku` files in write mode.

### 2.2 Final tool list (7 tools — composition, not proxy)

**Division of labor (the anti-duplication rule):** belay's tools exist only where the answer requires **composing** goal truth (keyoku files) × budget truth (tokenroom files) × hook enforcement state (belay files), or where a write must be *orchestrated* (create→autonomy→focus→arm as one confirmed act). Everything single-sourced stays a direct call to the existing servers:

| Stays a DIRECT keyoku MCP call | Why |
|---|---|
| `goal_assess` (ground truth — the loop's step 2), `goal_record`, `goal_get`/`goal_list` detail, `goal_converge`, workflows/knowledge/patterns/approvals/connectors/activity | Single-source; keyoku's guidance strings are model-facing by design; belay proxying would add latency + schema drift for zero composition value. Belay never runs probes (ADR-1), so it must never own `assess`. |

| Stays a DIRECT tokenroom MCP call | Why |
|---|---|
| `checkpoint`, `handoff`, `pin_fact`, `fit_check`, `plan_resume`, full `resource_state` | Continuity/planning surfaces; single-source. Belay only *reads* the resulting files. |

#### T1 `belay_status` — one call, the whole loop brain
```json
{ "name": "belay_status",
  "description": "One composed view: stack health, budget (attributed), focused goal + unmet criteria, loop arm/pause state, counters, and the would-block verdict the Stop hook would return right now. Every reported figure is read from state files; nothing is estimated or fabricated by belay — counters and the EXACT verdict need a session identity, so with no session_id and no session-pinned focus they come back unattributed (withheld) and the verdict is explicitly marked zero-history.",
  "inputSchema": { "type": "object", "properties": {
      "session_id": { "type": "string", "description": "this session's id if known — enables exact per-account budget attribution and per-session counters" },
      "cwd": { "type": "string", "description": "working directory to evaluate scope against (default: the server process cwd)" }
    }, "additionalProperties": false } }
```
Response fields → exact sources (nothing invented):

| Field | Source |
|---|---|
| `stack.tokenroom.{present,installed}` · `stack.keyoku.{registered,version,inRange}` · `stack.belay.{stop,preToolUse,sessionStart,mcpRegistered}` | `src/stack.mjs stackHealth()` (settings.json, `~/.claude.json`, keyoku package.json walk) |
| `budget.{known,left_pct,resets_at,est_tokens_left,stale,last_known_left,alt}` | `src/budget.mjs readBudget(sessionId)` over `state.json` / `accounts/<key>/state.json` / `sessions.json` / `profiles.json` |
| `budget.attribution` | tokenroom-ADR-24 rule reimplemented over `sessions.json`: entries with `at` within 10min → distinct `key`s; if ≥2 and no `session_id` arg, `windows` figures are withheld and `attribution` explains why (verbatim posture of `tokenroom/src/mcp.mjs:122-124`) |
| `goal.{id,slug,status,autonomy,usedIterations,maxIterations,lastAssessedAt,constraints}` | `src/keyoku.mjs readKeyoku()` → `focus.json` + `goals.json` row |
| `goal.unmet[]` (id + sanitized description) / `null` = no readable assessment | `unmetDetail(goal, obs)` over `observations/<goalId>.jsonl` tail (ADR-7 sanitization already applied) |
| `goal.assessment_age_min` | `max(lastAssessedAt, obs.at)` vs now (same freshness rule as `decideStop`) |
| `loop.{armed,paused,armed_at,armed_by,proposal_id}` | `~/.belay/loops.json` (§3.1) |
| `counters.{continuations,max,staleBlocked}` | `~/.belay/state.json` via `sessionEntry()` |
| `verdict.{action,kind,reason?}` | `decideStop(payload, k, budget, cfg, entry)` — the SAME pure function the hook runs (as `status.mjs` already does) |
| `proposals_open` (count only) | `~/.belay/proposals.json` (§4) |

#### T2 `belay_loop_create` — objective → armed loop, one confirmed call
```json
{ "name": "belay_loop_create",
  "description": "Create-and-arm an autonomous convergence loop. Either reference an existing keyoku goal or define one inline (criteria = machine-checkable probes + assertions, forwarded verbatim to keyoku's own goal_create). Belay routes all writes through keyoku's own process, focuses the goal, arms the loop, and returns the first would-block verdict. SCOPE (ADR-14): loops are SESSION-scoped by default — session_id is REQUIRED (the focus is pinned so only YOUR session is held) unless you pass scope:'global', which holds EVERY Claude Code session under the cwd subtree (an explicit opt-in; use only when conscripting sibling sessions is intended). THIS CALL IS THE CONFIRMATION that an autonomous loop should run; irreversible actions remain human-gated by the PreToolUse fall-arrest regardless.",
  "inputSchema": { "type": "object", "properties": {
      "goal": { "type": "string", "description": "existing keyoku goal slug or id (omit when defining inline)" },
      "objective": { "type": "string", "description": "inline creation: what converged looks like, one sentence" },
      "criteria": { "type": "array", "description": "inline creation: keyoku CriterionInput[] — {description, probe:{kind:command|http|mcp,…}, assert:{path?,op,value?}} — forwarded verbatim to keyoku goal_create, which validates them", "items": { "type": "object" } },
      "constraints": { "type": "array", "items": { "type": "string" } },
      "maxIterations": { "type": "number" },
      "confirm_autonomous": { "type": "boolean", "description": "REQUIRED true when `goal` references an existing goal whose autonomy is not already 'autonomous' — belay will then raise it via keyoku goal_update. Without it, non-autonomous referenced goals are refused (a loop must not silently convert a human-gated goal; ADR-2)." },
      "scope": { "type": "string", "enum": ["session", "global"], "description": "default 'session': the loop is pinned to session_id (required) and holds ONLY that session. 'global': no session pin — the Stop hook holds EVERY session under the cwd subtree until convergence (explicit opt-in; contradictory with session_id)." },
      "session_id": { "type": "string", "description": "the arming session's id (from the hook payload or the transcript path) — REQUIRED unless scope:'global'; the focus and the loop are pinned to it" },
      "cwd": { "type": "string", "description": "scope the focus to this project subtree (default: server cwd)" },
      "proposal_id": { "type": "string", "description": "when arming a surfaced proposal — marks it armed in the proposal log" }
    }, "additionalProperties": false } }
```
Pipeline (all keyoku writes via §2.4; each step's result echoed in the response):
1. **Resolve/create.** `goal` given → read `goals.json` to verify it exists (read-only). Inline → keyoku-child `goal_create` with `{objective, criteria, constraints, maxIterations, autonomy:"autonomous"}` — belay does **not** re-validate criteria; keyoku's zod errors return verbatim (single validator, no drift).
2. **Autonomy.** Existing goal not `autonomous`: require `confirm_autonomous:true`, then keyoku-child `goal_update {autonomy:"autonomous"}` (else refuse with the ADR-2 explanation). Existing `blocked` goal: refuse with guidance to raise `maxIterations` via keyoku directly (belay doesn't silently un-block).
3. **Focus.** keyoku-child `goal_focus {goal, cwd, sessionId?}` — keyoku owns `focus.json`; belay never writes it. **ADR-14:** default scope `session` REQUIRES `session_id` and pins it (refused pre-spawn otherwise); `scope:'global'` is the explicit unpinned opt-in.
4. **Arm.** Write `~/.belay/loops.json` entry (§3.1) `{armed:true, paused:false, armed_by, proposal_id?}`; reset this `(session_id ?? focus-scope, goalId)` counter entry in `~/.belay/state.json` (fresh loop = fresh continuation budget — same semantics as "focused goal changed" today); mark `proposal_id` armed in `proposals.json` when given.
5. **Report.** Return `belay_status` composition + `next: "run keyoku goal_assess to establish ground truth; the Stop hook will hold this session until convergence, budget floor, or the continuation cap"`.

Failure at any step → JSON-RPC *result* with `{ok:false, step, error}` (sanitized), nothing partially hidden; steps already completed are reported so the model can repair via direct keyoku calls.

#### T3 `belay_loop_list`
```json
{ "name": "belay_loop_list",
  "description": "All loop-relevant goals composed with belay's arm/pause metadata and counters: the focused goal, every active autonomous goal (armable), paused loops, and stale-converged goals (re-assess candidates).",
  "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } }
```
Source: `goals.json` (rows: status/autonomy/lastAssessedAt/convergedAt) × `focus.json` × `loops.json` × `state.json` counters. Read-only, no spawn.

#### T4/T5/T6 `belay_loop_pause` / `belay_loop_resume` / `belay_loop_disarm`
```json
{ "name": "belay_loop_pause",
  "description": "Pause the Stop-hook hold for one goal's loop (the session may stop freely). The PreToolUse fall-arrest stays ACTIVE while the goal remains focused — pausing the rope never pauses the arrest. State is belay-local; keyoku is untouched.",
  "inputSchema": { "type": "object", "properties": { "goal": { "type": "string" }, "note": { "type": "string" } }, "required": ["goal"], "additionalProperties": false } }
{ "name": "belay_loop_resume",
  "description": "Resume a paused loop. Clears the pause flag and the one-shot stale-block spend so the first stop re-demands fresh ground truth (goal_assess).",
  "inputSchema": { "type": "object", "properties": { "goal": { "type": "string" } }, "required": ["goal"], "additionalProperties": false } }
{ "name": "belay_loop_disarm",
  "description": "Fully stand down a loop: unfocus the goal via keyoku's own process (goal_unfocus) and clear belay's arm metadata. With no focused autonomous goal, both the Stop hold and the PreToolUse gate deactivate (belay returns to no-op).",
  "inputSchema": { "type": "object", "properties": { "goal": { "type": "string" } }, "required": ["goal"], "additionalProperties": false } }
```
- pause/resume: write `loops.json` only (no spawn). resume sets `staleBlocked:false` for matching session entries (forces a re-assess demand — never resumes onto stale truth).
- disarm: keyoku-child `goal_unfocus` (only if the focused goalId matches the argument — never blind-clears someone else's focus; the match is re-checked AFTER the child spawn, immediately before the RPC, so a focus grabbed by a concurrent arm in the ~1s spawn window is left untouched) + `loops.json` entry removed.

#### T7 `belay_propose`
```json
{ "name": "belay_propose",
  "description": "Scan today's state files for loop-worthy signals (deferred work past its resume time, unfocused unconverged autonomous goals, stale-converged goals needing re-assess, budget freshly reset, keyoku's own ripe suggestions) and return proposal objects — each with evidence (exact figures + source file) and a ready-to-pass belay_loop_create argument object. Proposals are NEVER auto-armed: arming happens only via an explicit belay_loop_create call.",
  "inputSchema": { "type": "object", "properties": {
      "dismiss": { "type": "string", "description": "proposal id to dismiss (won't be re-surfaced until its underlying signal changes)" }
    }, "additionalProperties": false } }
```
Source: `src/propose.mjs scan()` (§4). `dismiss` writes `proposals.json`.

### 2.3 What `belay status` (CLI) becomes
`belay status` and `belay_status` render from the same composition function (new `src/compose.mjs buildStatus()` extracted from today's `status.mjs`), so CLI and MCP can never drift — same discipline as `stack.mjs` sharing between bundle/doctor.

### 2.4 The keyoku write path — `src/keyoku-client.mjs`
- **Resolve:** the registered server spec from `~/.claude.json` via existing `allMcpServers()` — take the `keyoku` entry's `{command, args, env}` verbatim (live: `node …/keyoku-harness/dist/index.js`). Fallback: `$KEYOKU_INSTALL/dist/index.js`. Not found → tool returns `{ok:false, error:"keyoku MCP server not registered"}`.
- **Session:** spawn the exact registered command (+`serve` implied by default cmd), write newline JSON-RPC: `initialize` → `notifications/initialized` → `tools/call` per step → close stdin (keyoku's `serve()` shuts down on stdin end, `index.ts:99-102`). One child per `belay_loop_create`/`disarm` call; 15s hard timeout per call, child killed on timeout. Parse keyoku's `result.content[0].text` JSON.
- **Why this instead of the CLI:** no CLI goal-create exists; CLI `focus` can't set `sessionId` and takes cwd from the CLI's own cwd; the serve surface is keyoku's *primary, versioned* contract (same one Claude Code speaks), and spawning the registered command guarantees version match with the live server. Keyoku's cacheless read-modify-write store makes the concurrent short-lived writer safe by design (`store.ts:65-73`).
- **Latency budget:** ~0.5–1s per child incl. SDK startup — fine at MCP-call latency, forbidden at hook latency (hooks keep reading files, unchanged).
- **Injection posture:** everything keyoku returns that belay re-emits into model-visible text passes the existing ADR-7 sanitizers (`sanitizeText/sanitizeSlug/capReason`).

---

## 3. (b) Loop lifecycle + state — keyoku is the only brain

### 3.1 What belay adds under `~/.belay/` (and nothing else)
```
~/.belay/
  state.json       (existing — per-(session,goal) counters; unchanged shape)
  config.json      (existing — + new optional keys, §3.5)
  loops.json       NEW  { "loops": { "<goalId>": {
                       "armed": true, "paused": false,
                       "armed_at": <epoch>, "armed_by": "model"|"user"|"proposal:<id>",
                       "loop_scope": "session"|"global"   (ADR-14 provenance),
                       "session_id": "...", "cwd": "...", "note": "...",
                       "paused_at": <epoch|null> } } }
  proposals.json   NEW  { "proposals": [ { "id": "<sha256-12 of kind+key-fields>",
                       "kind": "resume-ready|unfocused-autonomous|stale-converged|budget-reset|keyoku-ripe",
                       "summary": "<sanitized ≤200>", "evidence": { ...exact figures + source path },
                       "suggested_create": { ...belay_loop_create args },
                       "created_at": <epoch>, "status": "open|dismissed|armed",
                       "surfaced_count": n } ] }
```
Atomic tmp+rename, 0700/0600 (existing `util.mjs`). Pruning: loops entries whose goal is gone from `goals.json`, or `converged` >7 days (read-time prune on write, like `state.json`); proposals: dismissed/armed >7d, open >48h re-derived on next scan (ids are content-hashes → a persisting signal reproduces the same id, so dismissal sticks until the signal itself changes).

**Single source of truth:** *what the loop is, its criteria, its convergence, its focus scope* = keyoku (`goals.json` + `focus.json`). Belay stores only what keyoku has no concept of: **armed-by provenance, pause, proposals, continuation counters.** No goal data is copied into `~/.belay` beyond the goalId key.

### 3.2 Hook changes (minimal, degrade-to-today)
`src/stop.mjs decideStop` gains ONE branch, inserted after the `paused` (keyoku-global) check and before scope checks conceptually — concretely after `k.goal` resolves:
```
if (loops[goal.id]?.paused === true) return { action: 'allow', kind: 'loop-paused',
  note: "[belay] loop for goal '<slug>' is paused (belay_loop_resume to re-arm) — allowing stop" };
```
- One extra file read (`loops.json`, ~0.1ms) in the hook path — within the 44ms budget.
- `loops.json` absent/malformed → `{}` → today's behavior exactly (ADR-4).
- **The hold condition is otherwise UNCHANGED:** any scope-matched focused active autonomous goal is held, armed-by-belay or not. Arming is provenance + counter-reset, not a new precondition — no dual brain, and a user who focuses an autonomous goal by hand still gets the loop, exactly as documented today.
- `gate.mjs`: **no change.** Pause deliberately does not consult `loops.json` (§3.4).
- ADR-6 termination argument is untouched: the new branch is an unconditional allow; blocks remain the two capped paths.

### 3.3 Lifecycle
```
 (proposal | model intent | user ask)
        │  belay_loop_create  = the explicit confirmation
        ▼
 keyoku goal_create/update ──► goal_focus ──► loops.json armed ──► counters reset
        │                                                            │
        ▼                        Stop hook feeds rope                ▼
   goal_assess (agent) ◄──────── block w/ unmet + budget ◄────── agent stops early?
        │ converged?                                                 │
        ├── yes → keyoku clears focus on convergence → hook allows → loop ends
        ├── paused (belay_loop_pause) → hook allows 'loop-paused' → resumable
        ├── budget floor / iterations / continuation cap → hook releases (descent)
        └── belay_loop_disarm → goal_unfocus via keyoku child → belay no-op again
```

### 3.4 Pause semantics — rope vs arrest (new ADR)
`belay_loop_pause` suspends **only** the Stop-hook hold. While the goal remains focused + autonomous + active, the PreToolUse gate keeps routing irreversible/external actions to the human. Rationale: a paused loop's session may still be doing goal-adjacent work; weakening the arrest on pause would make "pause" a gate-bypass primitive (exactly the self-weakening the constraints forbid). Dropping the arrest requires *disarm* (unfocus), which also ends the hold — there is no state with hold-on/arrest-off or any way for loop machinery to disable the gate.

### 3.5 Config additions (all optional, validated like the rest)
```jsonc
{
  "proposals_enabled": true,       // master switch for scan + SessionStart surfacing
  "proposal_max_surfaced": 3,      // per SessionStart injection
  "stale_converged_days": 7,       // converged goals older than this become re-assess proposals
  "keyoku_call_timeout_ms": 15000  // per keyoku-child JSON-RPC call
}
```

---

## 4. (c) Self-created loops — signals, proposals, no silent arming

### 4.1 Signals available TODAY from files (exact predicates)
| # | Signal | Predicate (all read-only) | Evidence carried |
|---|---|---|---|
| S1 | **Deferred work ready** | `~/.tokenroom/resume.json` valid per `readResume` rules (string summary, numeric created_at, <24h) AND `resume_at != null` AND `now >= resume_at` | `{summary(sanitized ≤200), est_tokens, resume_at, source:"~/.tokenroom/resume.json"}` → suggested_create: inline goal "finish deferred work: <summary>" with a placeholder criterion the model must concretize (proposal marked `needs_probes:true` — belay never invents machine checks) |
| S2 | **Unfocused unconverged autonomous goals** | `goals.json` rows: `status==="active" && autonomy==="autonomous" && id !== focus.goalId` (live data: ~12 such rows today) | `{goalId, slug, usedIterations/maxIterations, lastAssessedAt, unmet-tail if observations exist}` → suggested_create: `{goal:<slug>, cwd:<caller supplies>}` |
| S3 | **Stale-converged needing re-assess** (drift check — tokenroom ORCH.md:114's "stale-converged" note) | `status==="converged" && lastAssessedAt` older than `stale_converged_days` AND goal not abandoned | `{goalId, slug, convergedAt, lastAssessedAt, age_days}` → suggestion is a **direct keyoku `goal_assess` call**, NOT a loop (assess is free/read-only; a loop is only proposed if drift is then found) |
| S4 | **Budget fresh after reset** | `state.json` (or session's account state): `windows.five_hour.resets_at < now <= resets_at + 30min` (the crossedReset window `readBudget` treats as UNKNOWN — i.e. quota just refilled), OR `known && left_pct >= 85` while `loops.json` has a paused loop or S1 exists | `{resets_at, left_pct?|"post-reset (full)", source}` → suggested action: resume the paused loop / arm the S1 proposal — surfaced as an *amplifier* attached to those proposals, not standalone |
| S5 | **Keyoku's own ripe suggestions** (advisory) | `~/.keyoku/ripe.json` `{at, suggestions[]}` with fresh `at` (<24h) and non-empty suggestions, deduped against `surfaced.json` ids when present | keyoku's suggestion text (sanitized ADR-7 — this is cross-goal data) → surfaced verbatim-but-sanitized; suggested action: investigate via keyoku tools |

All five are pure file reads → safe at SessionStart-hook latency.

### 4.2 Pipeline
```
files ──scan()──► proposal objects ──┬── persisted to ~/.belay/proposals.json (content-hash ids, dedupe, dismissal sticks)
                                     ├── SessionStart hook: top `proposal_max_surfaced` open proposals as additionalContext
                                     │     "[belay] N loop proposals open: (1) <kind>: <summary> — arm with belay_loop_create({...}) or dismiss via belay_propose. Proposals are advisory; arming is your explicit call."
                                     │     (each line sanitizeText'd, whole block capReason'd ≤1.5KB — ADR-7: resume summaries, goal slugs, ripe text are all file-controlled input)
                                     └── belay_propose MCP tool: full list + evidence + ready suggested_create
                            arming: ONLY an explicit belay_loop_create(proposal_id) — that call IS the confirmation.
                            No auto-arm, no auto-focus, no hook ever writes keyoku state. Irreversibles stay gated regardless.
```
- **SessionStart hook** (`belay hook session-start`, additive install like Stop/PreToolUse, 10s timeout): runs `scan()`, persists, emits context. Zero proposals → zero output (silent, no-op posture). Scan errors → silent exit 0.
- **Scheduled routines** (user-armed, official): the README documents the pattern — the user creates a `/schedule` routine or their own cron'd `claude` session for a project; when that session starts, SessionStart surfaces the proposals and the model (per its instructions) may arm and work them. Belay itself never schedules or spawns anything.
- **Why the model may arm without a human click:** the hard-constraint text designates the explicit `belay_loop_create` call as the confirmation, and the safety story doesn't rest on arming — it rests on (i) autonomy is per-goal and was set explicitly, (ii) the PreToolUse arrest gates the irreversible frontier regardless of how a loop was armed, (iii) ADR-6 bounds every loop, (iv) the arm is provenance-logged (`armed_by:"proposal:<id>"`) and auditable via `belay_loop_list`.

---

## 5. (d) README story — "the Claude Code harness is the controller"

Draft section (to land in README under "How the pieces compose"):

> ## The harness is the controller
> Belay doesn't run agents. **Claude Code runs agents; belay makes Claude Code run them like a harness-of-harnesses** — every surface is an official one:
>
> - **Hooks enforce.** The Stop hook feeds rope: while your focused keyoku goal is unconverged, autonomous, and budget allows, ending the turn hands you back the unmet criteria instead of stopping. The PreToolUse gate is the fall-arrest: push/publish/send/destroy route to the human, even mid-loop, always. The SessionStart hook is the morning briefing: deferred work that's ready, autonomous goals nobody's driving, converged goals that may have drifted — surfaced as *proposals*, never as actions.
> - **MCP informs and commands.** `belay_status` is one call for the whole loop brain: goal truth (keyoku's files) × budget truth (tokenroom's files) × enforcement state (belay's counters and verdict). `belay_loop_create` turns an objective plus machine-checkable probes into an armed loop — goal created and focused through keyoku's own process, never by rewriting its files. Ground truth stays where it lives: `goal_assess` is keyoku's; `fit_check`/`handoff` are tokenroom's; belay composes, it doesn't proxy.
> - **The statusline shows.** tokenroom's HUD carries the budget countdowns and reset clocks the loop's descent decisions are made from.
> - **Schedules wake.** You (the user) arm official scheduled routines — `/schedule`, or your own cron that opens a session. When the session starts, belay's proposals are waiting in context; the model arms what's in scope with an explicit `belay_loop_create`, and the same rope-and-arrest rules apply from the first tool call.
>
> One brain, three truths: **keyoku decides what "done" means, tokenroom decides what you can afford, belay decides whether the harness keeps climbing** — and the human keeps the veto on everything irreversible.

Plus a "Loops" section documenting create/pause/resume/disarm, the proposal kinds, and the no-auto-arm guarantee.

---

## 6. (e) R-C build plan — Build → Refute → Harden

### 6.0 Round 0 (orchestrator, single-writer): contracts
1. Land ADRs 9–12 (§7) in `docs/DECISIONS.md` as PROPOSED; lock the tool schemas (§2.2) and file shapes (§3.1) as the contract.
2. Extend `test/helpers.mjs` in ONE commit (single writer) with: `writeLoops(h, loops)`, `writeProposals(h, ...)`, `writeResume(h, {summary, resumeAtAgoSec})`, `writeRipe(h, suggestions)`, `writeClaudeJson(h, {keyokuCmd})`, `mcpSession(h)` (spawn `belay mcp`, newline JSON-RPC driver, returns call/close), and `test/fixtures/fake-keyoku.mjs` (a ~80-line stdio JSON-RPC responder that implements initialize/tools/call for goal_create/update/focus/unfocus by mutating the fixture `KEYOKU_HOME` files the way real keyoku does — atomic writes, same shapes). After round 0, `helpers.mjs` is FROZEN for the round; agents may only add new helper files if truly needed.
3. `bin/belay.mjs`: add `mcp` + `hook session-start` dispatch stubs (routing only) so every agent codes against the final entry points.

### 6.1 Round 1 (parallel build) — DISJOINT ownership map
| Agent | Owns (writes ONLY these files) | Delivers |
|---|---|---|
| **A — mcp-server** | `src/mcp.mjs`, `src/compose.mjs`, `test/mcp.test.mjs` | Server loop (tokenroom pattern), tool registry with §2.2 schemas, `belay_status`/`belay_loop_list` (read-only composition via `compose.mjs buildStatus()`), tokenroom-ADR-24 attribution rule |
| **B — loops + keyoku client** | `src/keyoku-client.mjs`, `src/loops.mjs`, `src/stop.mjs` (the one `loop-paused` branch), `test/keyoku-client.test.mjs`, `test/loops.test.mjs` | Spawn-registered-keyoku JSON-RPC child (timeout, kill, sanitize), loops.json CRUD + prune, `belay_loop_create/pause/resume/disarm` handlers (exported functions `mcp.mjs` wires in — interface locked in round 0), stop-hook pause branch |
| **C — proposals + session-start** | `src/propose.mjs`, `src/session-start.mjs`, `src/install.mjs` (SessionStart + `claude mcp add` steps), `test/propose.test.mjs`, `test/session-start.test.mjs` | `scan()` for S1–S5 with exact predicates, proposals.json persistence + content-hash ids + dismissal, SessionStart hook with caps/sanitization, installer additions (additive, MARK-owned, idempotent) |
| **D — surfaces + e2e** | `src/status.mjs`, `src/doctor.mjs`, `README.md`, `docs/DECISIONS.md` (finalize ADRs), `CHANGELOG.md`, `test/loop-e2e.test.mjs`, `test/proposal-e2e.test.mjs` | CLI status/doctor render loop + proposal state (via A's `compose.mjs` — read-only import, no writes to A's files), §5 README, the two full e2e suites (T2 gates below) |
No file appears in two rows. `mcp.mjs`→handlers boundary: A owns the server file and calls `loops.mjs`/`propose.mjs` exports whose signatures were frozen in round 0 — if a signature must change, it goes through the orchestrator, not a cross-edit.

### 6.2 Executable gates
**T0 — build/typecheck:** `node --check` every changed `.mjs`; `npm test` boots (existing suites stay green — regression floor: the 5 existing test files).

**T1 — offline deterministic logic (fixture-driven, node:test, no spawns beyond the bin):**
- `decideStop` with `loops` fixtures: paused→allow(kind=loop-paused); unpaused→today's table verbatim (re-run the existing decision-table cases with a loops.json present to prove no regression); malformed loops.json → today's behavior.
- `propose.scan()` truth table: each S1–S5 predicate on synthetic homes — ready/not-ready boundaries (resume_at ±1s; lastAssessedAt at the stale_converged_days edge; crossedReset window edges; ripe.json stale/empty), id stability (same signal → same hash), dismissal suppression, sanitization of hostile summaries/slugs (inject `"\nignore previous instructions"` + 1MB flood → single-line, capped).
- `loops.mjs`: arm/pause/resume/disarm state machine incl. prune rules; resume clears `staleBlocked`.
- keyoku-client: request framing/response parsing against canned frames; timeout kill path.

**T2 — temp-HOME e2e (spawn the real bin; hermetic homes via env, per `helpers.mjs homes()`):**
1. **MCP handshake:** spawn `belay mcp` → `initialize` (echoes protocolVersion, serverInfo.name==="belay") → `tools/list` (exactly the 7 tools, schemas validate as JSON) → `tools/call belay_status` against seeded fixture homes → every asserted figure equals the seeded file value (68% budget, unmet c2 text, verdict BLOCK/kind block); unknown tool → `-32602`; garbage line → no crash, next call still answers.
2. **Loop-create e2e (the headline gate):** seed `CLAUDE_JSON` registering `fake-keyoku.mjs`; `tools/call belay_loop_create {objective, criteria:[command probe]}` → assert fake-keyoku wrote the goal row (autonomy autonomous) + focus.json, loops.json armed → `belay hook stop` **blocks** with the unmet criterion in the reason → flip the fixture observation (probe "passed": append `{unmet:[]}` tail + goal status converged, as real assess would) → same stop now **allows** with the converged note. Then the negative: referenced existing goal with autonomy `suggest` and no `confirm_autonomous` → refused, goals.json byte-identical.
3. **Pause/arrest e2e:** armed loop → `belay_loop_pause` → stop allows (`loop-paused` on stderr) **while** `hook pre-tool-use` on `git push` still returns `permissionDecision:"ask"` → `belay_loop_resume` → next stop blocks demanding assess (staleBlocked was cleared) → `belay_loop_disarm` → focus.json cleared by fake-keyoku, stop AND gate both silent.
4. **Proposal e2e:** seed resume.json past `resume_at` + 2 unfocused active autonomous goals + a converged goal 30 days stale → `belay hook session-start` emits additionalContext with ≤3 sanitized lines → `belay_propose` lists ≥4 with evidence matching seeded figures → `dismiss` one (re-scan keeps it dismissed) → `belay_loop_create {goal, proposal_id}` → proposal status "armed", loop live, stop blocks.
5. **Install e2e:** `belay install --dry-run/--config-dir` registers Stop+PreToolUse+SessionStart additively next to tokenroom-style entries (extend existing install.test.mjs patterns), uninstall removes only MARK entries.

**T3 — live-surface check (user-run, documented not CI):** `belay doctor` green on the real machine; one real `belay_loop_create` against live keyoku on a toy goal (`echo`-probe), one Stop-block observed in a live session, then disarm.

**T4 — adversarial refute (independent pass, read-only):** attack ADR-6 termination with pause/resume/disarm interleavings (must stay ≤ max_continuations+1 blocks per pair); attempt gate bypass via loop machinery (must be impossible by construction — no code path from loops.json to `decideGate`); prompt-injection via proposal summaries/ripe suggestions/keyoku child stderr; torn/concurrent loops.json + goals.json writes; two-account ambiguity in `belay_status`; fake-keyoku vs real-keyoku contract diff (fixture drift — compare fake's write shapes against `store.ts`).

Convergence = T0–T2 all executing and green + T4 refute pass agrees + doctor/status render on live state without error.

---

## 7. New ADRs to write (round 0, PROPOSED → ACCEPTED at convergence)
- **ADR-9 — belay MCP: composition, not proxy.** Hand-rolled stdio JSON-RPC (tokenroom pattern), zero deps; the 7-tool surface; every response field mapped to a file source; single-source questions stay with keyoku/tokenroom's own servers.
- **ADR-10 — keyoku writes only through keyoku's registered process.** Spawn the `~/.claude.json`-registered server command as a short-lived stdio child at MCP-call latency; never at hook latency; never file-writes; store cachelessness (`store.ts:65-73`) is the concurrency license; version pin >=2.7 <3 still doctor-checked.
- **ADR-11 — proposals never act.** Scan → persist → surface (SessionStart, sanitized+capped) → explicit `belay_loop_create` is the only arming path; content-hash ids make dismissal durable; `armed_by` provenance always recorded.
- **ADR-12 — pause suspends the rope, never the arrest.** No loop state can disable the PreToolUse gate; only disarm (unfocus, via keyoku) deactivates it, and it deactivates the hold too.

---

## 8. Decisions the orchestrator can veto (with recommendations)
1. **Keyoku write mechanism = spawn the registered server command as a JSON-RPC stdio child** (vs CLI verbs / vs telling the model to call `mcp__keyoku__*` itself). *Recommend: child.* CLI has no goal-create and its `focus` can't pin sessionId; the child is version-matched to the live server and is keyoku's primary contract.
2. **`belay_loop_create` dual-mode** (existing-goal ref OR inline creation forwarded verbatim). *Recommend: both.* Inline keeps "one call = one armed loop"; verbatim forwarding keeps keyoku the single validator. Fallback if vetoed: ref-only, model creates via keyoku MCP first.
3. **Stop-hold condition unchanged** (any focused active autonomous goal, armed or not); arming = provenance + counter reset only. *Recommend: keep.* Alternative (hold only armed loops) creates a dual brain and breaks today's documented behavior.
4. **Pause = rope only; gate stays** until disarm. *Recommend: keep* (fall-arrest constraint). Alternative (pause kills both) makes pause a gate-bypass.
5. **Model may arm proposals without a human click** (the explicit create call is the confirmation, per constraints). *Recommend: yes*, with `armed_by` provenance + gate + ADR-6 bounds as the safety story. Veto path: add `proposals_require_user: true` config making SessionStart wording instruct "ask the user first".
6. **`confirm_autonomous:true` required to raise an existing goal's autonomy.** *Recommend: keep* (ADR-2). Veto path: refuse entirely and require keyoku `goal_update` by hand.
7. **Budget attribution mirrors tokenroom ADR-24** (≥2 active accounts → withhold quota in `belay_status`). *Recommend: keep* — wrong-account numbers are worse than none.
8. **S3 stale-converged proposes a direct `goal_assess`, not a loop.** *Recommend: keep* — assess is free; auto-proposing loops for possibly-fine goals is noise.
9. **S5 (keyoku ripe.json) included as an advisory signal.** *Recommend: include* (it's keyoku's own background intelligence, read-only); cheap to drop if noisy.
10. **MCP registration via `claude mcp add` in `belay install`** (tokenroom pattern, `--no-mcp` opt-out). *Recommend: yes.*
11. **SessionStart surfacing caps: 3 proposals, ≤1.5KB total.** *Recommend: keep* (ADR-7 flood posture); tune via config.
12. **Ownership map §6.1 (A/B/C/D) with frozen round-0 contracts** (helpers.mjs + handler signatures). *Recommend: keep* — the one cross-boundary risk (mcp.mjs wiring B/C handlers) is contained by freezing export signatures in round 0.

## 9. Known risks / refute targets
- **Fake-keyoku fixture drift** vs real store shapes → T4 diff check + keep the T3 live smoke documented.
- **Keyoku child env:** the registered spec carries env (live: a plaintext `GEMINI_API_KEY`) — pass it through to the child verbatim but never log/echo env in errors (sanitize child stderr before surfacing).
- **`goal_create` inline mode with `criteria:[{...}]` free-form objects** in belay's schema (typed loosely, validated by keyoku): acceptable because keyoku's zod errors return verbatim; belay must cap forwarded payload size (~64KB) to avoid abuse.
- **SessionStart fires on every session** incl. compaction restarts — scan must stay <50ms (pure file reads; measured analogues ≈44ms worst case incl. node startup) and silent when nothing is open.
- **Windows paths** in `claude mcp add`/spawn (existing `resolveTokenroom` handles `where`): mirror that handling in keyoku-client.
