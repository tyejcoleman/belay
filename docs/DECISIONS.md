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
   (`stale-spent` / `unmet-unknown-spent`). So these fire **at most once, total, for the
   pair** — per explicit refund: `belay_loop_resume` refunds the flag (ADR-12) but is only
   accepted on a PAUSED loop, so each pause→resume cycle adds at most one (ADR-15).
3. Every other branch is an unconditional `allow` (absent / paused / no-focus /
   scope-mismatch / goal-missing / converged / non-active / non-autonomous /
   iterations-exhausted / budget-floor / nothing-unmet).

The only branches that BLOCK are (1) and (2), and both are hard-capped for the pair, so
belay emits **at most `max_continuations + 1` blocks per `(session, goal)`** and
thereafter can only `allow`. *(2026-07-02 hardening, refute L1-1: the proof implicitly
assumed serialized access — a concurrent stop hook writing a stale whole-map snapshot
could revert a just-persisted increment, degrading the bound one lost update per
ms-precision collision. `saveSessionEntry` now re-reads the freshest file at write time
and merges only its own entry (per-entry last-writer-wins, keyoku-store discipline), and
the loop-create/resume multi-entry writes go through the same `mutateOwnState` fresh-copy
path, shrinking the race window from tens of ms to the read→rename microseconds.)* This holds for *any* interleaving of `stop_hook_active` values
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

## ADR-9 — belay MCP: composition, not proxy *(ACCEPTED 2026-07-02 — build converged, refuted, hardened)*

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

## ADR-10 — keyoku writes only through keyoku's registered process *(ACCEPTED 2026-07-02 — build converged, refuted, hardened)*

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
child verbatim but is never logged or echoed in errors, and child stderr/stdout CONTENT
is withheld from surfaced errors entirely (hardened 2026-07-02, refute L2-3: a crashing
server can echo its env — provider SDKs put keys in request URLs, DEBUG modes dump env —
and format-only ADR-7 sanitization cannot redact secrets, so transport errors carry only
belay-authored text). The version pin >=2.7 <3 stays doctor-checked.

## ADR-11 — proposals never act *(ACCEPTED 2026-07-02 — build converged, refuted, hardened)*

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

## ADR-12 — pause suspends the rope, never the arrest *(ACCEPTED 2026-07-02 — build converged, refuted, hardened)*

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

## ADR-14 — loops are session-scoped by default

**Decision:** `belay_loop_create` defaults to `scope: "session"`: the caller MUST pass
`session_id`, and belay pins it in keyoku `goal_focus` (`{goal, cwd, sessionId}`), so the
Stop hold and the fall-arrest apply ONLY to the arming session. If `session_id` is absent
and `scope` is not explicitly `"global"`, the call is refused pre-spawn with an error
telling the model to pass `session_id` or `scope:"global"` — nothing is created or
focused. `scope:"global"` is the explicit opt-in for the old behavior (cwd-only focus that
holds every session under the subtree); combining it with `session_id` is refused as
contradictory. The chosen scope is recorded as `loop_scope` in the `loops.json` entry
(provenance, surfaced by `belay_status`), and the tool description states the default and
the opt-in in plain terms.

**Why:** keyoku's `focus.json` is a global singleton and `scopeMatch` holds ANY session
whose cwd is inside a cwd-only focus subtree. With `session_id` optional and unknowable to
the MCP server, the DEFAULT arm produced an unpinned focus that conscripted unrelated
sessions — observed live 2026-07-02 (TEST-A #2: the orchestrator session ate another
session's stale-block + unmet-block, did its work, and converged its goal). ADR-5 already
states the principle: "if ancestor/orchestrator sessions must be holdable, the opt-in is an
explicit sessionId pin, never a cwd subtree guess" — the same must hold for siblings.
Refusing (rather than silently arming unpinned) is the only honest default because belay
cannot discover the caller's session id (ADR-9: MCP calls carry no session id); the model
CAN — it is in every hook payload and the transcript path. The refusal text teaches
exactly that. The old description text ("scoped to this session/cwd") claimed a pin that
by default never happened; the description now says what the tool actually does.

## ADR-15 — counter semantics under the loop lifecycle: refunds only by explicit, paired calls

**Decision:** Three rules reconcile the loop lifecycle with the ADR-6 termination bound:
(1) `belay_loop_resume` is REFUSED unless the loop is currently paused — the ADR-12
stale-block refund therefore requires a `pause` first, and each pause→resume cycle can
add at most ONE extra block for a `(session, goal)` pair. (2) A session-scoped
`belay_loop_create` (the ADR-14 default) resets ONLY the arming session's counter entry —
never a sibling session's spent budget; an explicit `scope:'global'` arm resets the
focus-scope entries (every session driving the goal), which is DESIGN §2.2 step 4's
"focused goal changed = fresh budget" semantics. (3) The honest composite bound, stated
in DESIGN §6.2 T4: for any stop sequence, blocks per `(session, goal)` ≤
`max_continuations + 1 + (number of explicit pause→resume cycles) `, and with **no belay
MCP calls at all** the plain ADR-6 `max_continuations + 1` bound holds unchanged.

**Why:** Refute L1-3 proved the old T4 criterion ("must stay ≤ max_continuations+1 under
pause/resume interleavings") unsatisfiable against the mandated ADR-12 behavior: resume
refunded `staleBlocked` for every session even on an UNPAUSED loop (a free, repeatable
mint — one extra block per bare resume call), and re-arm zeroed every session's counters
(refunding a stranger's fully-spent budget). Every excess block still required an
explicit MCP call — pause itself releases the hold, so no involuntary wedge existed — but
the documentation claimed a bound the code could not meet. Rather than drop the ADR-12
refund (resuming onto stale truth un-assessed is worse), the refund is kept and made
expensive-and-paired, the reset is scoped to what the caller actually armed, and the
stated bound now tells the truth.

## ADR-16 — gate_mode 'defer': deny-with-guidance + a pending queue for one batched review

**Decision:** The config field `gate_mode` (`'ask'` | `'defer'`, default `'ask'`; any other
value falls back to the default with a warning) selects what the PreToolUse gate does when
an irreversible/external class matches under a focused autonomous goal. `'ask'` is the
standing ADR-3 behavior, byte-identical. `'defer'` returns `permissionDecision: "deny"`
with guidance — the action is deferred and queued; continue with sandbox-safe work — and
the hook appends it to `~/.belay/pending.json` (entry `{id, ts, class, tool_name, command
(capped 500), goalId, sessionId}`; `id` is a short content hash of class+command+goalId so
a retried action queues once; dir 0700 / file 0600 / atomic tmp+rename, the state.mjs
pattern) for ONE batched human review at convergence: the converged-stop allow adds a
stderr reminder ("N deferred action(s) await approval — run 'belay pending'"),
`belay status` / `belay_status` carry `pending: {count, classes}`, and
`belay pending [--clear | --remove <id>]` is the review surface. **The queue is
presentation metadata and is NEVER consulted by any gate or stop decision — no code path
leads from `pending.json` to a decision** (the ADR-12 no-path rule, mirrored). The
spawn-tools thin-budget branch stays `'ask'` in BOTH modes: it is a budget question, not
irreversibility. Under `bypassPermissions`, defer already denies, so ADR-13's semantics
are preserved unchanged.

**Why:** `'ask'` stalls an unattended loop until a human answers — in exactly the session
nobody is watching, the prompt just parks the goal mid-climb. Deny is strictly SAFER than
ask: the action never runs, the arrest is never weakened, and the guidance keeps the
model making sandbox-safe progress while the human reviews everything in one batch at
convergence instead of being paged per action. The default stays `'ask'` because ADR-3's
posture — the human decides, live — is right for every attended session; defer is the
explicit opt-in for unattended runs. Because no decision ever reads the queue, a
hostile/corrupt/deleted `pending.json` degrades to "0 pending" (ADR-4) and no loop
machinery can launder an approval through it — a queue entry is a reminder, never a
permission. A failed queue append never drops the deny (the arrest lands even when the
bookkeeping doesn't).

**Known limitation (accepted):** `appendPending` is a lockless read-modify-write — two
hook invocations racing in the same instant can lose one entry (last-writer-wins; the
rename keeps the file uncorrupted and both denies still fire). Accepted because the queue
is presentation metadata, distinct-entry races require two gate hits in the same moment,
and a lockfile in a never-crash hook path buys little for its failure modes. Revisit with
an append-only `pending.jsonl` if real losses are ever observed.

## ADR-17 — the learned adjudicator is refine-only; fail-safe is stage 1; the daemon is untrusted

**Decision:** The PreToolUse gate gains an opt-in **stage 2**: after a stage-1 hit, the
hook (never the pure `decideGate`) may consult a local learned-adjudicator daemon
(`POST slm_url`, the CGS `GATE-ADJUDICATOR-PLAN.md` §3 JSON contract; config
`slm_enabled` default **false**, `slm_url` default `http://127.0.0.1:8642/adjudicate`,
`slm_timeout_ms` 1500, `slm_min_confidence` 0.9). The class split is **enforced in code,
never by the model**: **HARD classes** (`git push`, `npm publish`, `gh mutation`,
`external send/publish`) are never sent to the daemon (pointless + latency) and are never
unlockable — no SLM output can change their stage-1 decision (a well-formed rationale may
be appended for the human, sanitized per ADR-7, decision untouched). **SOFT classes**
(`rm -rf outside cwd`, `network write`, and every config `ask_patterns` class — soft is
defined as *not hard*) may be refined by the pure `mergeVerdict`: an `allow` verdict is
accepted ONLY when the response is well-formed AND `abstain === false` AND
`confidence >= slm_min_confidence` (→ silent allow, nothing queued); a `defer` verdict is
accepted only when `gate_mode` is `'defer'`, where the stage-1 ADR-16 defer-queue deny
(queue entry included) is itself the accepted outcome; **everything else** — malformed,
abstain, low confidence, `ask`, timeout (AbortController hard cap), non-200, bad JSON,
oversized body, daemon absent — degrades to the stage-1 decision **byte-identically**
(`mergeVerdict` returns the very same object). Stage 2 is also skipped for the
spawn-budget ask (no class hit) and under `bypassPermissions`: the ADR-13 deny is final —
the one mode where no prompt of any kind reaches a human is not softenable by a daemon.
`decideGate` stays pure and behaviorally untouched when `slm_enabled` is false.

**Why:** Stage 1's provability rule deliberately over-asks (the CGS census found real
misfires: `rm -rf "$SANDBOX"` on mktemp dirs, read-only `curl` pipelines with no
parseable URL), and in an unattended defer loop every over-ask parks real work in the
review queue. A small calibrated local model can lift exactly the provable-over-ask cases
— but it sits outside belay's trust boundary, so it is treated as **untrusted input**: an
absent, slow, flooding, malformed, or fully **compromised** daemon gets, at worst,
today's behavior on every HARD class and a bounded SOFT allow (one action stage 1 would
have asked about runs) — never a new capability, never a weakened HARD arrest, never a
prompt-injection channel (rationales pass through `sanitizeText`/`capReason`), and never
a crash or a wedged hook (every failure path resolves within `slm_timeout_ms` and lands
on stage 1, the ADR-4 posture). The fail-safe is provable and tested: with the daemon
**stopped** and `slm_enabled: true`, gate output is byte-identical to 0.3.0 for every
class (`test/gate-slm.test.mjs`, the plan's convergence criterion c7).

*(2026-07-04 — catch-mode, `slm_catch` default false: the mirror of refine. Stage 1 is a
denylist and is fundamentally incomplete (`$(echo git) push`, `eval $var`, a binary not in the
table); catch-mode consults the daemon on a stage-1 MISS and lets it ADD an ask/defer for a
command the denylist can't express (`catchVerdict`). This is the SAFE direction to trust an
untrusted daemon: catch only ever ADDS friction, so an absent/slow/malformed/compromised daemon
can at worst cause an over-ask — never a fail-open (any non-`ask`/`defer`, low-confidence, abstain,
timeout, or bad response → the command passes, byte-identical to catch off). It runs only for a
real command under a focused autonomous goal, respects `gate_mode` (ask, or defer-queue), and
`decideGate` stays pure — the network call lives in the hook, exactly like refine. Requires
`slm_enabled`; both default off.)*

## ADR-18 — wrapper-aware, config-extensible command classification *(2026-07-03)*

**Decision:** The gate classifies dangerous Bash by SCANNING the whole command string for the
binary regardless of shell wrapper, quoting, or chaining — not by walking the leading token of
each `&&`/`;` segment. `classifyVcs` (git/npm/gh) and `classifyDanger` (a data-driven table)
both anchor on a command boundary (`[\s;|&`'"(=]`), so `sh -c 'git push'`, `bash -lc`, `eval`,
backticks, `$(…)`, `(subshell)`, a lone `&`, `env FOO=bar git push`, and case variants
(`GIT`/`RM` on a case-insensitive FS) all still classify. `gh api` non-GET/field writes,
`npm publish` behind value-taking globals (`--registry <url> publish`), `curl/wget` DELETE/PATCH
and bundled/attached flags (`-sX POST`, `-da=1`, `-Tfile`), and `find … -exec rm -rf {} +` are
all caught. Coverage of the long tail (docker/kubectl/terraform/aws/…) is a DATA table:
`DEFAULT_DANGER_BINARIES` in code, UNIONED with the user's `config.json` `danger_binaries`
(`{binary:[subs]|['*']}`) — extending it to a new stack is one config line, never a code change.
The classifier deliberately OVER-asks (ADR-3: a false ask is safe; a false allow is a
fall-arrest failure); user `ask_patterns` run before the built-in table so a user can relabel a
generic hit with their own class + note.

**Why:** The pre-2026-07-03 `classifyVcs` inspected only the leading binary of each segment, so
`sh -c 'git push'` — the single most common way an autonomous agent runs a command — silently
allowed an irreversible push under an autonomous goal, in both `ask` and `defer` mode, untested.
A denylist can never be complete (irreversibility is not syntactically decidable), so the design
answer is not "enumerate everything in code" but "make the deterministic hook layer fast + dumb +
wrapper-proof, and make its coverage data-driven so the user closes their own gaps." A
property/fuzz test (`test/gate-fuzz.test.mjs`) now exercises the wrapper × binary × flag space
the hand-picked example suite never covered — it found two real bugs during this build (an `env`
prefix swallowing the real binary; a case-sensitive subcommand miss), both fixed.

## ADR-19 — the arrest and the verifier are self-protecting (loop-control class) *(2026-07-03)*

**Decision:** A HARD gate class `loop control` routes the tools that can REMOVE the arrest or
WEAKEN the criteria holding the session to the human: `belay_loop_disarm`, and keyoku
`goal_focus` / `goal_unfocus` / `goal_update` / `goal_converge` / `goal_delete`
(`LOOP_CONTROL_ASK`). A second HARD class `control-file tampering` gates any write-ish Bash
command targeting belay's or keyoku's OWN control files (`~/.belay`, `~/.keyoku`) —
`touch ~/.keyoku/paused` (no-ops the whole harness), `> ~/.keyoku/focus.json` (clears the
arrest), `echo '{"gate_enabled":false}' > ~/.belay/config.json` (disables the gate). Both fire
only while a focused autonomous goal already exists, so normal use is untouched; pure reads of
those files are not gated. The ADR-13 bypass-deny text no longer advertises "disarm the loop,
then retry" — that path laundered the arrest (disarm is itself gated, and standing the loop down
does not make the irreversible action approved). Under bypass the honest guidance is: run it from
a non-bypass session.

*(2026-07-03 refute hardening: the first cut gated only `goal_unfocus`/update/converge/delete
and `belay_loop_disarm`; an adversarial pass found `goal_focus`→another-goal and one-line control-
file writes as equivalent self-liberation, both now closed. Accepted residual limits: a `goal_focus`
to a NEW autonomous goal the model also created is gated, but the deeper truth is that any denylist
of tool names / control-file writes is best-effort — the real backstop remains that autonomy is
per-goal + opt-in, and irreversibles route to the human. Filesystem tampering via an interpreter
that constructs the path dynamically (`python -c`, `eval $var`) is undecidable by a static gate and
out of scope; `python3?`/`node`/`perl` targeting a literal `.keyoku`/`.belay` path IS gated.)*

**Why:** Two audited holes. (1) Self-liberation: under `bypassPermissions`, the ADR-13 deny told
the model to call `belay_loop_disarm` — which was ungated — clearing the focus and turning the
gate into a no-op, so the retried `git push` executed with no human ever contacted, two tool
calls later, following the deny's own instructions. (2) Verifier tampering: a held model could
call `goal_update`/`goal_converge` to weaken or fake-pass the very criteria holding it (edit the
test, not the code) with no gate. Both are the same failure — the loop machinery must not be able
to disable its own arrest or verifier — so both are closed by one class, HARD (never
SLM-unlockable). Editing keyoku's files directly via Bash is still gated by the file-write
classes; `belay_loop_pause` is intentionally NOT gated (it releases the rope, never the arrest).

## ADR-20 — install/uninstall are non-destructive and self-healing *(2026-07-03)*

**Decision:** `install`/`uninstall` distinguish an ABSENT settings.json (fresh `{}` is fine) from
a PRESENT-but-unparseable one, and REFUSE to write over the latter (exit 1) — the old code parsed
any failure as `{}` and wrote that back, silently destroying the user's permissions/model/other
hooks (uninstall had no backup at all). Uninstall now backs up first like install; both write via
atomic tmp+rename. Re-install REFRESHES a stale owned hook command (rewrites the node/bin path)
instead of reporting "already installed", and `belay doctor` FAILs a registered hook whose quoted
command path no longer exists (moved package / upgraded node) instead of greping the MARK
substring and calling it "registered".

**Why:** A single stray comma in settings.json turned `belay uninstall` into "delete my entire
Claude Code config, no backup." And a moved package left both the rope and the arrest silently
dead (hooks are non-blocking) while doctor reported everything green — the worst failure mode for
a safety tool is looking healthy while being inert. Install sits on the harness's critical path;
its failure budget for destroying user state is zero (ADR-4 spirit, extended to the installer).

## ADR-21 — thrash-aware + compaction-surviving stop guidance (the intelligence layer) *(2026-07-03)*

**Decision:** Belay's model-facing text now compensates for a mid-tier model's long-horizon
weaknesses, all within the never-crash hook paths and WITHOUT touching the ADR-6 termination
proof: (a) **thrash detection** — the session entry carries `lastUnmetHash` + `sameUnmetCount`;
when the same unmet SET survives `thrash_threshold` (default 3) blocks, the reason switches from
"keep going" to "your approach isn't moving these — run the probe yourself, record the diagnosis,
CHANGE strategy; two more no-delta ⇒ mark it blocked". (b) **final-continuation wrap-up** — the
LAST held block directs a clean landing (goal_assess, goal_record the blockers, checkpoint,
human summary, do NOT claim success) instead of a silent stderr release the model never sees.
(c) **prioritization** — the normal block says "pick ONE criterion, cheapest to verify". (d)
**compaction re-briefing** — SessionStart re-injects a live loop's objective/unmet/constraints/
counters/budget (`buildLoopBriefing`) so a compacted session doesn't resume blind; previously it
surfaced only proposals, and a mid-flight loop is not a proposal. (e) **orphaned-loop proposal
(S6)** — an armed, session-pinned loop whose arming session is gone from tokenroom's sessions.json
surfaces "resume here or disarm."

**Why:** The audit's effectiveness review found belay was an excellent SAFETY harness but a thin
COGNITIVE one: the block text was byte-identical on continuation 2 and 19 (a thrashing model
sailed through), a compacted session restarted with zero goal context, and an exhausted-but-
unconverged model was released silently and wrote a confident summary of a failed task. These are
exactly the mid-tier failure modes the harness exists to paper over so an Opus-class model
performs at Fable level on long-horizon autonomous work. Every change is TEXT + tiny counter
state: the block still increments the continuation counter and is still hard-capped, so the loop
is still provably terminating (thrash/final-continuation only change wording, never the count).

*(2026-07-03 refute hardening: `unmetDetail` — shared by decideStop, buildStatus, and the new
briefing — was O(unmet × criteria) (`criteria.find` per id); a pathological/hostile goal with tens
of thousands of criteria could run it for ~21s, blowing the Stop hook's 10s timeout so the hook is
KILLED and the stop fails OPEN — the exact failure ADR-4/ADR-6 forbid. Fixed by indexing criteria
in a Map (O(1) lookup) and capping materialized ids at 500; measured 21.6s → 12ms at 100k×100k.)*

*(2026-07-03 Phase 3: three deeper-autonomy pieces. **Adaptive budget** — a loop stuck on the
SAME unmet set past `thrash_release` (default 8) gets ONE model-visible escalation block, then
`thrash-exhausted` releases it on the next stop, so a hopeless loop stops at ~8 continuations
instead of 25. This is only ever an earlier ALLOW (never a later block), so ADR-6's block bound
holds and termination is strictly tighter; `sameUnmetCount` is persisted so the release is
monotonic until real progress resets the streak. **Learning flywheel** — every disarm writes a
loop retro (thrash/convergence/continuations) to `~/.belay/retros.jsonl` (pure local, no spawn),
and `belay loop retro <goal>` files it into keyoku's `knowledge_submit` via keyoku's own process
(ADR-10, best-effort) so belay's unique telemetry grounds future `goal_assess` guidance — keyoku
stays the single brain (ADR-9), belay only contributes an observation it alone holds; no new MCP
tool (the 7-tool surface stays frozen). **Probe-driven e2e** — a `probe-keyoku` fixture that
actually RUNS the criterion probe, so `test/probe-e2e.test.mjs` proves the loop flips block→allow
on a real exit-code change, closing the test-review realism gap.)*

## ADR-22 — observability + assurance: belay watches its own enforcement *(2026-07-04)*

**Decision:** belay gains two self-facing surfaces. **`belay insights`** mines belay's OWN
decision journal (`~/.belay/decisions.jsonl`) + retros + pending + proposals into a read on how
the harness is actually behaving — buckets every decision by MEANING (idle no-op / released /
HELD / GATED), reports the no-op rate (high = correctly not policing normal work), fall-arrest
acts by class, loop outcomes/thrash, and hook liveness (age of the last journaled decision). To
make the fall-arrest measurable, the PreToolUse hook now journals its ASK/DENY acts (only when it
acts — never on the silent-allow hot path, so the 99% case is untouched). **`belay selftest`** is
the hook-contract canary: it spawns the real Stop + PreToolUse hooks against a throwaway world and
asserts they block / arrest (incl. behind a shell wrapper) — proving the enforcement CODE PATH is
intact on THIS install — then reads the real journal to confirm the LIVE harness is actually
invoking the hooks. `retro_auto_push` (config, default false) optionally files each disarm's retro
into keyoku's knowledge store, closing the learning loop.

**Why:** belay's enforcement rides Claude Code's hook contract — a surface it does not control,
and which has broken before (`bypassPermissions` silently auto-yes'd "ask", ADR-13). A harness
whose enforcement can go silently dead needs to WATCH ITSELF: `selftest` turns "hope the hooks
fire" into "know they fire," and the liveness read distinguishes "code path intact" from "harness
actually invoking it." And a 460-entry journal that nothing reads back is wasted signal — the two
hardest correctness properties (staying a no-op for normal work, never conscripting foreign
sessions) are only *claims* until the journal shows them holding at scale; `insights` makes them
observable (measured live: 94% idle, 204 foreign-session stops correctly allowed). Both are pure
reads over belay's own files (no new keyoku dependency, no new MCP tool — the 7-tool surface stays
frozen, ADR-9); the gate-journal write is best-effort and never affects a decision (ADR-4).

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
