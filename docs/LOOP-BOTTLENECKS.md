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

- [B3] **One focused goal at a time** — STATUS: **DONE** (ADR-25)
  keyoku focus is a global singleton; belay held only the focused goal, so two *different* loops
  couldn't run in parallel across terminals (arming a second re-points focus, releasing the first).
  **Fix (ADR-25, belay-only):** the goal a Stop steers is now derived PER SESSION from belay's own
  `loops.json` (the armed, non-paused, `session_id`-pinned loops whose goal is active) instead of
  keyoku's `focus.json` singleton — so a global focus flip by another session can never evict this
  session's loop. Generalized to a per-session PORTFOLIO: `decidePortfolio` steers a session's WHOLE
  owned set (round-robin, one goal per stop; allow only when all converge), each goal independently
  capped so ADR-6 termination holds (`≈N·max_continuations` bound). Per-(session, goal) counters in a
  new additive `state.json` `portfolios` map; single-goal state byte-identical. Proof in
  `test/portfolio.test.mjs` (264 total green).
  **Left as a KNOWN RISK (tracked, not done):** keyoku's OWN live capture (`autoRecordToFocusGoal`)
  still misattributes/loses actions under concurrent multi-goal focus because keyoku's `focus.json`
  is a singleton (v2.18.0, no per-session focus map). This degrades keyoku's trace/learning fidelity
  only — NOT belay's steering, the no-eviction property, or termination. A real fix needs a MINIMAL
  keyoku change (per-session focus map, single-focus default preserved); deliberately out of scope
  under the belay-first mandate (published package — not touched, not published).

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
