# Decisions (ADR log)

Standing decisions with their why. Do not silently violate one — propose a new ADR.

## ADR-1 — Files, not processes

**Decision:** Conductor reads Keyoku's state files (`focus.json`, `goals.json`,
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
checked by `conductor doctor` against keyoku's package.json when findable; (b) a
doctor **layout self-check** that validates the actual files against the contract, so a
layout change fails loudly on inspection instead of silently no-opping forever; (c)
every read degrades to "no goal" (ADR-4), so the failure mode of a layout change is
conductor doing nothing — never doing something wrong. We also never *write* keyoku's
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
But conductor is not the authority on what's allowed — the user is. "ask" surfaces the
question through the harness's own permission flow with the goal context attached; the
human decides. `allow_overrides` exists so a user can pre-approve classes they trust
(e.g. pushes to a preview branch); `ask_patterns` extends the class list. Spawn gating
under thin budget is the same posture: an expensive subagent is an indivisible bet, so
below the floor the human confirms it, conservatively including stale-low readings
(a stale "8% left" is more likely 8% than refilled; a truly absent tokenroom gates
nothing because there was never a measurement).

## ADR-4 — Degrade to no-op, everywhere

**Decision:** Any absent, malformed, stale, or torn input — keyoku missing, corrupted
JSON, unknown fields, bad config, garbage stdin — degrades to conductor doing
*nothing*: hooks exit 0 silently (a top-level try/catch at the bin dispatch guarantees
it), bad config fields fall back to defaults with a doctor warning, and budget UNKNOWN
is permissive for stop decisions (block without a budget line rather than invent one).

**Why:** tokenroom's ADR-5 lesson, inherited: Claude Code surfaces hook failures as
unattributed error banners, and a Stop-hook crash can wedge a session. Conductor's
failure budget is zero because it sits on the harness's critical path. The corollary is
scope humility: conductor must be a strict no-op for normal interactive use — no
focused autonomous goal, no behavior. Own state is hardened like tokenroom's
(dirs 0700, files 0600, atomic tmp+rename writes).

## ADR-5 — Scope match is ONE-WAY for a blocking decision

**Decision:** For the Stop hook (and the gate), a cwd-scoped focus matches a session only
when the **session's cwd is inside the focus subtree** (`a === b || a.startsWith(b + '/')`).
Conductor does **not** mirror keyoku's bidirectional attribution (which also matches when
the focus cwd is inside the session cwd). The trailing-slash strip is guarded so a cwd of
`/` (which strips to `''`) can never match everything.

**Why:** keyoku's `autoRecordToFocusGoal` matches either direction because attribution is
advisory — a wrong guess just mis-labels a recorded action. Conductor makes a **blocking**
decision, so it must be conservative. Under the old bidirectional rule, a session running
in an **ancestor** of the goal's cwd matched the focus — so an orchestrator at the repo
root, or any shell at `/` or `$HOME`, would have its Stop **held for a goal it is not
driving**, for as long as the focus stayed cwd-only (keyoku pins `sessionId` only on the
first matching action, so cwd-only focus is the normal initial state). The failure mode of
a wrong match is blocking a stranger's stop; one-way matching removes that class entirely.
A genuinely global focus (no sessionId, no cwd) still matches all — that is a scope the
user explicitly chose. If ancestor/orchestrator sessions must be holdable, the opt-in is an
explicit `sessionId` pin, never a cwd subtree guess.

## Non-ADR notes

- **Compliance line (from the mission):** official surfaces only — Stop and PreToolUse
  hooks plus the user's own dotfiles. Conductor continues work within a session and
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
