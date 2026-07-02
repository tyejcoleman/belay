# Decisions (ADR log)

Standing decisions with their why. Do not silently violate one — propose a new ADR.

## ADR-1 — Files, not processes

**Decision:** Belay reads Keyoku's state files (`focus.json`, `goals.json`,
`observations/*.jsonl`, the `paused` marker) and tokenroom's (`state.json`,
`sessions.json`, `profiles.json`) directly. Hooks never spawn either tool's process and
never run Keyoku probes.

**Why:** Measured on 2026-07-01: a keyoku CLI spawn costs 160–264ms per invocation —
too heavy for hooks that fire on every stop/tool call — while raw node file reads land
≈44ms including interpreter startup. Probes are arbitrary shell with 300s timeouts;
running them from a hook could wedge the harness. All keyoku writes are atomic
tmp+rename or single-line JSONL appends, so concurrent reads are safe (torn trailing
lines are skipped).

**Accepted risk + mitigation:** the file layout is keyoku's *internal* surface, and its
store layer reserves a future SQLite swap. Mitigation: (a) version pin **>=2.7 <3**,
checked by `belay doctor` against keyoku's package.json when findable; (b) a
doctor **layout self-check** that validates the actual files against the contract, so a
layout change fails loudly on inspection instead of silently no-opping forever; (c)
every read degrades to "no goal" (ADR-4), so the failure mode of a layout change is
belay doing nothing — never doing something wrong. We also never *write* keyoku's
files: goals.json is a whole-array last-writer-wins clobber risk.

## ADR-2 — Only autonomous goals block a stop

**Decision:** The Stop hook self-continues only when the focused goal's autonomy is
`autonomous`. `observe`, `suggest`, and `approve` goals always allow the stop.

**Why:** Those three levels *define* a human in the loop — observe never acts, suggest
proposes, approve asks first. A hook that keeps the agent working against them would
convert a human-gated goal into an autonomous one from the outside, violating the
autonomy contract the user chose at `goal_create`. The gate follows the same rule: it
only polices sessions that an autonomous goal is actually driving.

## ADR-3 — Approval classes route to the human ("ask", not "deny")

**Decision:** Irreversible/external actions under an autonomous goal (git push,
npm publish, gh PR/release/repo mutations, `rm -rf` outside cwd, curl/wget writes to
non-localhost, MCP send/publish tools) emit `permissionDecision: "ask"` — never `"deny"`,
never a silent rewrite.

**Why:** Autonomy inside the workspace does not imply autonomy over the *world*
(pushes, publishes, messages to humans are irreversible or externally visible).
But belay is not the authority on what's allowed — the user is. "ask" surfaces the
question through the harness's own permission flow with the goal context attached; the
human decides. `allow_overrides` exists so a user can pre-approve classes they trust
(e.g. pushes to a preview branch); `ask_patterns` extends the class list. Spawn gating
under thin budget is the same posture: an expensive subagent is an indivisible bet, so
below the floor the human confirms it, conservatively including stale-low readings
(a stale "8% left" is more likely 8% than refilled; a truly absent tokenroom gates
nothing because there was never a measurement).

## ADR-4 — Degrade to no-op, everywhere

**Decision:** Any absent, malformed, stale, or torn input — keyoku missing, corrupted
JSON, unknown fields, bad config, garbage stdin — degrades to belay doing
*nothing*: hooks exit 0 silently (a top-level try/catch at the bin dispatch guarantees
it), bad config fields fall back to defaults with a doctor warning, and budget UNKNOWN
is permissive for stop decisions (block without a budget line rather than invent one).

**Why:** tokenroom's ADR-5 lesson, inherited: Claude Code surfaces hook failures as
unattributed error banners, and a Stop-hook crash can wedge a session. Belay's
failure budget is zero because it sits on the harness's critical path. The corollary is
scope humility: belay must be a strict no-op for normal interactive use — no
focused autonomous goal, no behavior. Own state is hardened like tokenroom's
(dirs 0700, files 0600, atomic tmp+rename writes).

## ADR-5 — Scope match is ONE-WAY for a blocking decision

**Decision:** For the Stop hook (and the gate), a cwd-scoped focus matches a session only
when the **session's cwd is inside the focus subtree** (`a === b || a.startsWith(b + '/')`).
Belay does **not** mirror keyoku's bidirectional attribution (which also matches when
the focus cwd is inside the session cwd). The trailing-slash strip is guarded so a cwd of
`/` (which strips to `''`) can never match everything.

**Why:** keyoku's `autoRecordToFocusGoal` matches either direction because attribution is
advisory — a wrong guess just mis-labels a recorded action. Belay makes a **blocking**
decision, so it must be conservative. Under the old bidirectional rule, a session running
in an **ancestor** of the goal's cwd matched the focus — so an orchestrator at the repo
root, or any shell at `/` or `$HOME`, would have its Stop **held for a goal it is not
driving**, for as long as the focus stayed cwd-only (keyoku pins `sessionId` only on the
first matching action, so cwd-only focus is the normal initial state). The failure mode of
a wrong match is blocking a stranger's stop; one-way matching removes that class entirely.
A genuinely global focus (no sessionId, no cwd) still matches all — that is a scope the
user explicitly chose. If ancestor/orchestrator sessions must be holdable, the opt-in is an
explicit `sessionId` pin, never a cwd subtree guess.

## ADR-6 — Belay's own bounded budget replaces the stop_hook_active blanket-allow

**Decision:** The Stop hook no longer consults Claude Code's `stop_hook_active` flag at all
— it neither blanket-allows on it nor resets counters on it. Every stop is evaluated, and
loop termination is governed **solely** by belay's own durable, monotonic
per-`(session, goal)` guards. The continuation counter resets only when the focused goal
changes (`sessionEntry` keys on `goalId`) or after the 7-day prune — never as a function of
harness-supplied state.

**Why:** Every stop that follows a hook-forced continuation carries
`stop_hook_active: true` (that is exactly the flag Claude Code sets when a Stop hook returns
`{"decision":"block"}`). Blanket-allowing on it capped the goal loop at **one** forced
continuation per turn: `max_continuations` (25) was unreachable, and if that single
continuation was spent by the one-shot **stale-block**, the "keep working on unmet
criteria" push never fired at all — the whole point of the feature was defeated. The tests
masked it by sending every synthetic stop with `stop_hook_active: false`, so the early-allow
was never exercised; they now include a mid-chain (`true`) stop that must still block.

We considered *resetting* the counter on a fresh stop (`stop_hook_active !== true`) to give
each user turn its own budget. Rejected: that makes termination **depend on the harness
setting `stop_hook_active`**. If any harness (or a bug) never sets it, every stop would look
"fresh", reset the counter, and block forever — an infinite forced-continuation wedge,
exactly the failure ADR-4 forbids (belay's failure budget on the critical path is
zero). A safety property must not rely on external cooperation, so termination is anchored
to belay's own monotonic counter instead.

**Termination argument (provably bounded for ANY sequence of stops):** Fix a
`(session, goal)`. `session_id` is stable within a session and the counter is persisted to
`~/.belay/state.json` (atomic write) and re-read on every stop, so it is durable across
the per-stop process spawns. Consider the stops for this pair in order:

1. **Unmet-criteria block** does `continuations := continuations + 1` and persists it — the
   counter is strictly increasing on this path and is never decreased (nothing resets it
   short of a goal change / prune). Once `continuations >= max_continuations` the decision
   is `allow` (`continuations-exhausted`). So this path fires **at most `max_continuations`
   times, total, for the pair** — independent of budget, assessment freshness, or the
   `stop_hook_active` flag.
2. **Stale block** and **unmet-unknown block** (ADR-7) are one-shot: each sets
   `staleBlocked = true` and persists it; with the flag already set the decision is `allow`
   (`stale-spent` / `unmet-unknown-spent`). So these fire **at most once, total, for the pair**.
3. Every other branch is an unconditional `allow` (absent / paused / no-focus /
   scope-mismatch / goal-missing / converged / non-active / non-autonomous /
   iterations-exhausted / budget-floor / nothing-unmet).

The only branches that BLOCK are (1) and (2), and both are hard-capped for the pair, so
belay emits **at most `max_continuations + 1` blocks per `(session, goal)`** and
thereafter can only `allow`. This holds for *any* interleaving of `stop_hook_active` values
(including all-`false` and all-`true`), so the loop is provably terminating. All
allow-guards are reachable: `continuations-exhausted` is reached by any non-converging
autonomous goal after `max_continuations` blocks regardless of every other input — it is the
worst-case backstop that guarantees the agent is eventually released.

## ADR-7 — Sanitize sibling-derived strings in model-visible reasons

**Decision:** Every string that originates from another goal's data — the focused goal's
`slug`, unmet criterion ids and descriptions, and the tokenroom profile `label` — is
sanitized before it is interpolated into a Stop-hook block `reason` (which Claude Code
feeds back as model-visible context). Control chars/newlines are stripped, each description
is capped at 120 chars, the joined unmet list at 1.2 KB, slugs/labels are constrained to a
tame charset, and the whole reason is capped at ~2 KB.

**Why:** A hostile or careless *sibling* goal (any row in `goals.json`, not necessarily the
one the user is driving) controls its criteria descriptions and slug; a directly-written
`profiles.json` controls the label. Those flowed **verbatim, unbounded, unsanitized** into
the block reason — a prompt-injection channel ("ignore previous instructions…") and a
context-flood channel (a megabyte of criteria text) aimed straight at the model. Belay
is on the harness's critical path and speaks in the harness's own voice, so it must treat
all cross-goal data as untrusted input. Sanitizing at the boundary keeps the legitimate
signal (the criteria to work on) while removing the injection/flood surface. The same fresh
goal with **no readable assessment** (unmetDetail → null, distinct from `[]`) is not
silently released: belay blocks once demanding `goal_assess`, reusing the one-shot
`staleBlocked` guard so it cannot loop.

## ADR-8 — Renamed `conductor` → `belay`

**Decision:** The package is branded **belay**. The command/bin is `belay`
(`bin/belay.mjs`); the npm package is **`belay-harness`**; the state dir is `~/.belay`
(env `BELAY_DIR`); block/ask reasons carry the `[belay]` prefix; the installer MARK and
backup suffix are `belay.mjs` / `.belay-bak`. Prior internal releases used `conductor`
(and the placeholder npm name `conductor-harness`, kept `private`). Historical CHANGELOG
entries and this log's earlier ADRs are read as describing the same tool under its old
name; the standing behavior is unchanged by the rename.

**Why the metaphor:** in climbing, the *belayer* manages the rope for the climber —
feeding slack so they keep ascending, and locking off to **arrest a fall** if they slip.
That is precisely belay's two surfaces: the **Stop hook feeds rope** (it keeps the agent
climbing toward the goal while the goal is unconverged and budget allows), and the
**PreToolUse gate is the fall-arrest** (irreversible/external actions — push, publish,
external sends, destructive deletes — lock off and route to the human). "Conductor"
described orchestration; "belay" names the actual safety-and-continuation contract, which
reads better against the Stop-continuation + fall-arrest-gate design.

**Why `belay-harness` on npm:** the bare `belay` package name is already taken (verified);
`belay-harness` is free and doubles as a fitting name — a *harness* is the climber's
gear the rope clips into, and this is a Claude Code **harness** integration. The bin stays
the short `belay`. Removed `private: true` so the package is publishable (publishing itself
is a user-side step — see the README).

## ADR-9 — belay MCP: composition, not proxy *(PROPOSED — accepted at build convergence)*

**Decision:** `belay mcp` is a hand-rolled newline-delimited stdio JSON-RPC 2.0 server
(tokenroom's proven pattern: readline over stdin, `JSON.stringify + '\n'` out; zero deps).
The surface is exactly **7 tools** (`belay_status`, `belay_loop_create`, `belay_loop_list`,
`belay_loop_pause`, `belay_loop_resume`, `belay_loop_disarm`, `belay_propose` — schemas
frozen in `src/mcp.mjs TOOLS` and docs/DESIGN.md §2.2). Belay's tools exist only where the
answer requires **composing** goal truth (keyoku files) × budget truth (tokenroom files) ×
enforcement state (belay files), or where a write must be orchestrated as one confirmed
act. Every response field maps to an exact file source; budget-unknown stays unknown.
Single-source questions stay DIRECT calls to keyoku's and tokenroom's own servers
(`goal_assess`, `goal_record`, `checkpoint`, `fit_check`, …) — belay never proxies them.

**Why:** Proxying single-source tools would add a spawn's latency and schema drift for
zero composition value, and would put belay in the business of relaying keyoku's
model-facing guidance. Composition is the one thing no other tool can answer ("what would
the Stop hook do right now, and can I afford it?"), so that is the whole surface. The
hand-rolled transport keeps the zero-dependency invariant and is the same pattern already
proven in production by tokenroom. `belay status` (CLI) and `belay_status` (MCP) render
from the same `compose.mjs` functions so the two can never drift. Budget attribution
mirrors tokenroom's ADR-24: MCP calls carry no session id, so with ≥2 accounts active in
the last 10 minutes and no `session_id` argument, quota figures are withheld with an
explicit `attribution` note — wrong-account numbers are worse than none.

## ADR-10 — keyoku writes only through keyoku's registered process *(PROPOSED — accepted at build convergence)*

**Decision:** When belay must WRITE keyoku state (goal_create / goal_update / goal_focus /
goal_unfocus for loop create/disarm), it spawns the `~/.claude.json`-registered keyoku
server command verbatim (`{command, args, env}` from the same `allMcpServers()` parse the
doctor uses) as a short-lived stdio JSON-RPC child — `initialize` →
`notifications/initialized` → `tools/call` per step → close stdin — with a hard per-call
timeout (`keyoku_call_timeout_ms`, default 15s, child killed on breach). This happens at
**MCP-call latency only, never at hook latency**; hooks keep reading files (ADR-1
unchanged). Belay never rewrites `goals.json`/`focus.json` and never re-validates
criteria — keyoku's own zod errors return verbatim (single validator, no drift).

**Why:** There is no CLI goal-create, and CLI `focus` can't pin a sessionId; the serve
surface is keyoku's *primary, versioned* contract — the same one Claude Code speaks — and
spawning the registered command guarantees version match with the live server. Keyoku's
store is explicitly cacheless (every read goes to disk; mutations are read-modify-write
over the freshest copy), which is the concurrency license for a short-lived second keyoku
process. The measured spawn cost (160–264ms + SDK startup) is fine per MCP call and
forbidden per hook (≈44ms budget). The registered spec's `env` passes through to the
child verbatim but is never logged or echoed in errors, and child stderr is sanitized
(ADR-7) before surfacing. The version pin >=2.7 <3 stays doctor-checked.

## ADR-11 — proposals never act *(PROPOSED — accepted at build convergence)*

**Decision:** The proposal pipeline is scan (pure file reads over the S1–S5 signals) →
persist (`~/.belay/proposals.json`, content-hash ids) → surface (SessionStart
`additionalContext`, sanitized per-line and capped ≤1.5KB total, top
`proposal_max_surfaced` only; plus the `belay_propose` tool) → and the ONLY arming path is
an explicit `belay_loop_create` call, which records provenance
(`armed_by: "proposal:<id>"`). No auto-arm, no auto-focus, no hook ever writes keyoku
state. Ids are content-hashes of the signal's key fields, so dismissal sticks until the
underlying signal itself changes. Belay never invents machine checks: an S1
(deferred-work) suggestion ships `needs_probes: true` for the model to concretize.

**Why:** Surfacing and acting must be separated by an explicit, attributable call — the
constraint text designates the `belay_loop_create` call as the confirmation, and the
safety story does not rest on arming anyway: autonomy is per-goal and was set explicitly,
the PreToolUse arrest gates the irreversible frontier regardless of how a loop was armed,
ADR-6 bounds every loop, and the arm is provenance-logged and auditable via
`belay_loop_list`. The surfaced text is built from file-controlled input (resume
summaries, goal slugs, keyoku ripe text), so the full ADR-7 sanitize+cap posture applies;
zero open proposals means zero output (the silent no-op posture of ADR-4).

## ADR-12 — pause suspends the rope, never the arrest *(PROPOSED — accepted at build convergence)*

**Decision:** `belay_loop_pause` suspends ONLY the Stop-hook hold (one unconditional-allow
branch keyed on `loops.json` `paused`). While the goal remains focused + autonomous +
active, the PreToolUse gate keeps routing irreversible/external actions to the human —
`gate.mjs` does not consult `loops.json` at all, by construction. Dropping the arrest
requires **disarm** (goal_unfocus via keyoku's own process), which also ends the hold.
There is no state with hold-on/arrest-off, and no code path by which loop machinery can
disable the gate. Resume clears the one-shot `staleBlocked` spend so the first stop after
resume re-demands fresh ground truth (`goal_assess`).

**Why:** A paused loop's session may still be doing goal-adjacent work; weakening the
arrest on pause would make "pause" a gate-bypass primitive — exactly the self-weakening
the fall-arrest constraint forbids. Keeping the pause flag belay-local (keyoku untouched)
preserves the single-brain rule: what the loop *is* stays keyoku's; whether belay is
currently feeding rope is belay's. The stop-hold condition is otherwise unchanged (any
scope-matched focused active autonomous goal is held, armed-by-belay or not), and the new
branch is an unconditional allow, so the ADR-6 termination argument is untouched.

## ADR-13 — bypassPermissions escalates the gate's "ask" to "deny"

**Decision:** In the PreToolUse gate, when the hook payload reports
`permission_mode: "bypassPermissions"` AND a scope-matched focused **active autonomous**
goal exists, every decision that would be `ask` (both the irreversible-action classes and
the thin-budget spawn floor) is escalated to `permissionDecision: "deny"`, with a reason
that states exactly why and how to proceed: run the action from a session without
bypassPermissions, or fully stand the loop down first (`belay_loop_disarm` /
keyoku `goal_unfocus` — pause is NOT enough, ADR-12). In every other permission mode the
decision stays the plain ADR-3 `ask`. `belay doctor` additionally warns when
`permissions.defaultMode` is `bypassPermissions` in settings.json/settings.local.json.

**Why:** Observed live 2026-07-02 (HANDOFF-TEST.md TEST A finding #3): under
`defaultMode: bypassPermissions` the harness auto-resolves `ask` — the gate provably
emitted `permissionDecision:"ask"` for `git push --dry-run` and the push executed with no
prompt ever shown. `deny` IS enforced under bypass; `ask` is not. ADR-3's contract is
"belay makes sure the question gets asked" — when the harness cannot ask, the only way to
keep the human in the loop is deny-with-instructions. This is NOT a reversal of ADR-3's
ask-not-deny posture: in every mode where an ask can actually be rendered, ask remains the
decision; the deny fires only where "ask" would have meant "silently allow", which is the
exact fall-arrest failure the gate exists to prevent. The escalation applies to the spawn
floor too, because an unaskable ask is a lie in all cases — the deny reason tells the model
to do the work inline instead.

## Non-ADR notes

- **Compliance line (from the mission):** official surfaces only — Stop and PreToolUse
  hooks plus the user's own dotfiles. Belay continues work within a session and
  advises across sessions; it never launches headless runs and never touches
  credentials.
- **profiles.json shape** — tokenroom R3.5 shipped: the real file is
  `{profiles:{<label>:{keys:[...], last_seen, last_windows_snapshot:{at, five_hour:{used_pct,
  resets_at}}}}}` (mapped 2026-07-01 against tokenroom `src/accounts.mjs`
  `writeProfiles`/`updateProfileSnapshot`). `pickAltProfile` now iterates
  `Object.entries(raw.profiles)` for that map shape and `normalizeProfile` reads
  `left = 100 - five_hour.used_pct`, `at = snapshot.at ?? last_seen`, and `resets_at` from
  `five_hour.resets_at`; a profile self-excludes by any of its `keys[]` buckets, and a
  reading past its `resets_at` is dropped (wrong-signed, mirroring `readBudget`'s
  crossedReset rule). Older shapes (flat map, array, `{profiles:[]}`, top-level
  `left_pct`/`used_pct`) are still parsed defensively. Before this fix `budget.alt` was
  always `null` against real data — every alt-profile behavior was inert.
