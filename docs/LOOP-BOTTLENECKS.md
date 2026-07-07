# LOOP-BOTTLENECKS — living backlog for the belay/keyoku autonomous-loop system

Maintained by the loop **manager** (the orchestrating session). Each item: symptom → root cause →
fix/status. Goal `belay-handles-any-loop` drives these to resolution using the loop itself.

- [B1] **Coarse-criteria false-thrash** — STATUS: **DONE** (ADR-23)
  belay measured progress as unmet-criteria-IDs changing (`sameUnmetCount`/`lastUnmetHash` in
  `src/stop.mjs`). A goal whose criteria are big multi-session milestones (e.g. openkakushin-recomp
  c3 "the whole engine shim") makes real per-session progress — commits, `goal_record` iterations —
  that never *flips* a criterion, so belay's thrash detection escalated and RELEASED a productively-
  advancing loop (observed: "same criteria across 4 assessments → releasing the hold"). **Fix
  (ADR-23):** the thrash EARLY-RELEASE is now gated on the goal's DECLARED horizon — a goal with
  `maxIterations >= cfg.milestone_iterations` (default 200) is a declared multi-session milestone, so
  the early-release is suppressed and `cfg.max_continuations` remains the sole per-session bound. The
  declared horizon is a STATIC, non-gameable signal (recording junk bumps `usedIterations` toward
  keyoku's `iterations-exhausted` stop, not away from termination); `usedIterations`-delta-as-progress
  was rejected as gameable. ADR-6 preserved on BOTH axes — per session `max_continuations`, across
  sessions keyoku's iteration budget — so a NO-progress loop still terminates. Proof in
  `test/milestone-progress.test.mjs`.

- [B2] **`goal_update` cannot edit criteria** — STATUS: TRACKED
  Refining a goal's criteria (e.g. splitting a coarse criterion into per-brick sub-criteria) needs
  `goal_create` + abandon; no in-place edit. Makes iterating on goal granularity heavy and loses the
  action trace. Candidate: a keyoku `goal_recriteria` op, or belay guidance to size criteria per-session.

- [B3] **One focused goal at a time** — STATUS: TRACKED
  keyoku focus is a global singleton; belay holds only the focused goal, so two *different* loops
  can't run in parallel across terminals (arming a second re-points focus, releasing the first).
  Candidate: multi-focus keyed by session_id, or a belay-side session→goal map.

- [B4] **Session-scoping friction** — STATUS: TRACKED
  belay loops are session-scoped and require the arming session's `session_id`
  (`$CLAUDE_CODE_SESSION_ID` / transcript filename); easy to get wrong, and no auto-detect.
  Candidate: belay auto-reads the id from the hook payload / env at arm time.

- [B5] **"Stop hook error" label** — STATUS: WON'T-FIX (external) / MITIGATED
  Claude Code hardcodes the Stop-hook block label as "error" (only alternative is "feedback" via
  `additionalContext`, a weaker mechanism that risks continuation). Not belay-controllable. Mitigated
  by rewording belay's message to `[belay ⟳ steering]`. Product feedback for Anthropic.

- [B6] **Autonomy-level ↔ PreToolUse gate not wired** — STATUS: **NEW** (found live via dogfooding)
  loop-setup declares a run's autonomy level (L0/L1/L2 + allowlist) in the LEDGER, but belay's
  PreToolUse fall-arrest gate (`belay.mjs hook pre-tool-use`) independently defers outward actions
  regardless of that level. Observed: under an agreed **L2 (may push)** run, a committed B1 fix's
  `git push` was still deferred — *"queued for batched human approval at convergence (gate_mode:
  defer)."* Safe default, but for "belay handles any loop" the declared autonomy/allowlist must FLOW
  INTO belay's gate policy (gate reads the loop's level → permits allowlisted actions, stages the
  rest) so an L2 run isn't silently downgraded. Until then, staged pushes await batched approval.

- [B7] **Forced continuations while background work is in-flight (EFFICIENCY)** — STATUS: **DONE** (ADR-24)
  When the facilitator dispatches a background sub-agent/Workflow and then stops, belay's Stop hook
  still fires and — if the goal is unconverged — FORCES a continuation, even though the harness
  auto-resumes the main agent when the worker completes (task-notification). If the main agent has no
  other actionable work, that continuation is a WASTED SPIN (tokens burned waiting). Observed live:
  while the keyoku-baseline worker ran, belay kept steering the facilitator. **Fix:** make the loop
  EVENT-DRIVEN — belay ALLOWS the stop when background work is in-flight AND no criterion is
  independently actionable (a lightweight in-flight marker the facilitator writes on dispatch /
  clears on completion; the Stop hook reads it → allow). The harness completion-notification then
  resumes the loop. "Continuous but not excessive": advance on worker-completion events, not forced
  ticks. Does NOT touch the safety gate — a clean, safe belay improvement.
  **Fix (ADR-24):** the facilitator's EXPLICIT, SESSION-SCOPED marker `~/.belay/await.json` (set via
  `belay await on`, cleared via `belay await off`; keyed by `session_id` like `state.mjs`). `hookStop`
  reads `isAwaiting(p.session_id)` and passes it to `decideStop`, which returns an unconditional
  `{ action: 'allow', kind: 'awaiting-async' }` above every block path — the loop then advances on the
  harness's completion event, not a forced spin. ALLOW-ONLY: it never forces a continuation and leaves
  every block path and its cap byte-for-byte unchanged, so ADR-6 termination is untouched (the block
  count can only DECREASE). Proof in `test/await-async.test.mjs` (marker→allow, byte-identity without
  the marker, session-scope A-allows-B-blocks, plus module + CLI edges).
