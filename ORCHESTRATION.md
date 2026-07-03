# ORCHESTRATION.md — Belay → SOTA Meta-Harness (Gated-Convergence Build)

*Re-read FIRST on every re-invocation. Untracked — do NOT commit.*
*Started 2026-07-02 00:47. Orchestrator: main session, cwd ~/Development. Prior build's brain
(C1–C7, converged 07-01 22:55): ~/Development/tokenroom/ORCHESTRATION.md — historical reference.*

## Objective (user, 2026-07-02 00:43)

1. tokenroom + keyoku **fully updated, published, working, locally in sync**.
2. **Belay** (~/Development/conductor, npm `belay-harness`, formerly "conductor") becomes the
   ONE meta-harness the user uses: runs autonomous loops (has), **creates loops on its own**
   (new), **MCP-accessible from Claude Code** (new), positions the Claude Code harness as the
   **controller** (hooks + MCP + statusline + scheduled routines as the control plane).
   "Truly SOTA and remarkable."

## Compliance lines (inherited, NON-NEGOTIABLE — from tokenroom CLAUDE.md + belay README + ADR-22)

- Official Claude Code surfaces only (hooks, MCP, statusline, OTel, user dotfiles).
- Never headless quota burn, credential reuse, undocumented endpoints.
- Fall-arrest stays: irreversible/external actions route to human (`permissionDecision:"ask"`)
  even under autonomous goals. Loop self-creation must NOT weaken this.
- Never rewrite keyoku state files externally — spawn keyoku's own CLI/record hook
  (read contract: tokenroom/ORCHESTRATION.md lines 110–117).
- tokenroom repo hard gates (check-invariants.mjs, ADR-9 eval) are respected, never routed around.

## Convergence criteria (machine-checkable)

| ID | Criterion | Gate (executes) | Status |
|---|---|---|---|
| K1 | keyoku released + pushed + checkouts synced | `npm view keyoku version` == LIVE == DEV package.json · `git status -sb` ahead 0 in both · full suite green (≥288) | **GREEN 00:54** |
| K2 | tokenroom stable released IF ADR-9 eval passes (else documented blocker, rc stays) | eval results in eval/ · `npm view tokenroom dist-tags` latest=0.6.0 · tag pushed · `npm test` + invariants green · doctor clean | **GREEN 01:08** |
| K3 | belay armed + working locally | `belay doctor` all [ok] (Stop+PreToolUse registered) · `npm test` green · no-op-without-focus verified | **GREEN 00:52** |
| K4 | belay MCP server live from Claude Code | registered in ~/.claude.json · T2: stdio JSON-RPC handshake lists tools · tool calls return truth against fixture $HOME | **GREEN 09:44** (registered user-scope by test session; T2 gates + refute-hardened) |
| K5 | loop creation: objective → keyoku goal (via keyoku's own process) → focused → armed | T2 temp-HOME e2e: `belay loop create` → stop-hook blocks with unmet criteria → probe passes → assess → stop allowed | **GREEN 09:44** (e2e green; ADR-14 session-scoped default) |
| K6 | self-created loops: belay PROPOSES loops from signals (tokenroom resume-ready, idle unconverged goals) — human/model confirms, gate preserved | fixture-driven tests: signal present → proposal surfaced (SessionStart/MCP); no signal → silence; proposals never auto-execute irreversibles | **GREEN 09:44** (S1-S5 suites green; SessionStart hook installed) |
| K7 | belay published + docs tell the controller story | `npm view belay-harness version` == local · README architecture section · repo pushed ahead 0 | **GREEN 09:44** (belay-harness@0.2.0 on npm, main pushed 850e085) |
| K8 | REFUTE pass agrees | read-only adversarial workflow → ASSURANCE.md → harden → all gates re-green | **GREEN 09:44** (17/17 findings fixed, ADR-13/14/15, 171/171 tests) |

## CONVERGED 2026-07-02 09:45 — all K1-K8 GREEN

Final: keyoku 2.17.0 (npm+github+both checkouts) · tokenroom 0.6.0 stable (npm w/ provenance,
headroom-harness deprecated) · belay-harness 0.2.0 (npm, pushed 850e085, 171/171, armed live:
Stop+PreToolUse+SessionStart hooks + MCP user-scope, doctor exit 0). ADRs 9-15. Known cosmetic
leftover: 3 unused-param lints on FROZEN signatures (mcp.mjs argv, stop.mjs p, scaffold.test env)
— intentional signature stability, not defects. USER-SIDE remainders: rotate npm token (urgent);
tokenroom launch announcement awaits go (launch/RUNBOOK.md); rm -rf ~/.headroom when pre-rename
sessions gone; TEST B in HANDOFF-TEST.md ready to run in a fresh session.

## Round plan

- **R-A (DISPATCHED 00:47, 3 writer agents on DISJOINT targets + 1 read-only):**
  A1 keyoku release (writers: both keyoku checkouts) · A2 tokenroom release (writer: tokenroom;
  ADR-9 eval attempt, cost-capped ~$5, NO stable publish if eval not green) · A3 belay local arm
  (writer: ~/.claude/settings.json via belay's own installer only) · A4 research+design (read-only;
  design doc → scratchpad).
- **R-B (DONE 01:01):** design ingested; ALL 12 designer decisions ACCEPTED as recommended.
  Contract source of truth: scratchpad/belay-sota-design.md (scaffold copies it to docs/DESIGN.md).
  Locked: 7 MCP tools (status/loop_create/loop_list/pause/resume/disarm/propose), hand-rolled
  stdio JSON-RPC per tokenroom mcp.mjs pattern; keyoku writes ONLY via spawned registered-server
  JSON-RPC child; ~/.belay/loops.json+proposals.json (provenance only, keyoku = single brain);
  5 proposal signals, SessionStart ≤3/1.5KB sanitized, arming only by explicit loop_create;
  fill ownership A(mcp) B(keyoku-client/loops/stop-branch) C(propose/session-start/install)
  D(status/doctor/docs/e2e); bin verb dispatch + helpers + fake-keyoku FROZEN in scaffold.
- **R-C:** BUILD workflow (one writer: conductor repo): scaffold-locks-interfaces → fill disjoint
  files (mcp server / loop engine / proposals / doctor+bundle extensions / tests) → T1+T2 gates.
- **R-D:** REFUTE workflow (read-only) → HARDEN → publish belay-harness + push → final report.

## Decisions

1. R-A via 4 background Agents, not Workflows — bounded single-writer jobs (precedent: prior build D3).
   R-C/R-D use Workflows per playbook (CLAUDE.md mandates ultracode workflows for wide rounds).
2. Publishing IS authorized this build — user's words: "fully updated published". Exception:
   tokenroom stable stays gated on ADR-9 eval (repo hard gate; rc already claims the name).
3. belay publish happens ONCE, after the SOTA upgrade (R-D), not twice.
4. "Creates loops on its own" = belay AUTHORS + PROPOSES loops from observed signals and can arm
   them under policy — but irreversible actions still ask, and proposals are surfaced through
   official prompts (SessionStart context / MCP tool result), never silent execution. This is the
   compliance-honest reading; recorded as the design assumption.
5. Keyoku live server processes keep running old code until sessions restart — activation is
   user-visible, noted in final report (cannot restart the server serving this session).

## R-C GREEN 02:02 (wf_1d1e4b32-864 complete — 7/7 agents, 1.05M subagent tokens)

- 152/152 tests. Commits on main (NOT pushed): 319bd6f scaffold + 04db87f loops/keyoku-client +
  A/C/D module commits (see git log). Gate: T0 152/152 · T1 mcp 13 + loops 24 + keyoku-client 11 +
  propose 19 + session-start 13, hermetic (mkdtemp homes, fake-keyoku as registered server, zero
  network imports) · T2 e2e-sota 12/12 + autonomous-e2e 3/3 (handshake proto echo, 7 tools,
  garbage-tolerant; create→block(stale)→block(unmet c1 + real budget line)→flip→allow; ADR-2
  refusal byte-identical goals.json; pause keeps arrest=ask; resume re-arms) · realStateUntouched
  TRUE (sha256 254 files; only ~/.keyoku/ripe.json moved = ambient keyoku, controlled).
  Verdict tail truncated in ingest — re-confirm zeroDeps at R-D start (expected clean).
- K4/K5/K6 = CODE-GREEN. Remaining for full green: live `belay install` (registers SessionStart
  hook + belay MCP in ~/.claude.json — doctor's 2 accurate warns), refute pass, publish.
- QUOTA LANDED 02:02 (3% ≈15k, resets 05:30). R-D DEFERRED. Do NOT use tokenroom plan_resume
  (single slot holds Polya queue). **RESUME R-D (this session at 05:30, or fresh session sooner —
  other account's window resets 02:20, pair-switch is zero-downtime):**
  [08:36 RESUMED on fresh window. Step 1 DONE: verdict tail = GREEN, failures [], deps NONE,
   devDeps NONE, main ahead 6, tree clean. Step 2 IN FLIGHT: refute workflow wf_33d78a7f-5fc
   (5 lenses → skeptic verify → gate-honesty audit). Next on ingest: steps 3-6.]
  1) re-verify gate zeroDeps: package.json diff vs 45ae7bf^ (no deps) + journal tail wf_1d1e4b32-864
  [09:08 REFUTE DONE wf_33d78a7f-5fc: 17 raw → 13 confirmed (5 major: L2-1 disarm clobbers
   concurrent focus · L2-3 env secret in stderr tail → MCP error text · L4-1 wrong-account quota
   on ambiguity · L4-2 fabricated status-probe counters · L5-F1 cross-session capture default)
   + 4 audit (major F1 hermetic-gate spawns real keyoku · F2 = L5-F1; minor F3 tarball omits
   docs · F4 version 0.1.0). Full findings: tasks/wxqmtj0y2.output (.result). TEST A field
   findings (HANDOFF-TEST.md): #2 pin sessionId default (=L5-F1) · #3 fall-arrest no-op under
   bypassPermissions. ORCHESTRATOR POLICY RULINGS for harden: (a) loop scope default = session
   (require session_id or explicit scope:'global'; fix tool description honesty L5-F4);
   (b) under bypassPermissions + focused autonomous goal, gate escalates ask→DENY for
   irreversibles (deny is enforced in bypass; reason explains re-run outside bypass or disarm)
   + doctor warns — new ADR; (c) version → 0.2.0, CHANGELOG fold, docs/ into tarball;
   (d) hermetic gate must force fake-keyoku (F1); (e) remove stray repro-l1-3.mjs if in repo.
   HARDEN+RELEASE agent dispatched 09:09. Live-arm ALREADY DONE by test session (belay install:
   MCP user-scope + SessionStart hook, doctor green) — step 5 SKIPPED.]
  2) REFUTE workflow (read-only): 5 lenses (stop/gate decision-table honesty vs DESIGN.md, keyoku-client
     spawn/injection, propose signal spoofing, MCP protocol robustness, cross-session loop scoping incl.
     the 01:10 live-fire sessionId-pinning question) × skeptic verify → findings list
  3) HARDEN (one writer, conductor repo): fix confirmed findings + lint sweep (unused-var diags in
     mcp/stop/propose/tests) → full suite re-green
  4) bump version, npm publish belay-harness, push main
  5) live-arm: node bin/belay.mjs install (SessionStart + MCP registration) + doctor all-ok
  6) fill HANDOFF-TEST.md TEST B (belay_status / belay_loop_create / belay_propose via MCP in a
     fresh session) + final report + mark K4-K8 in matrix.

## R-C build dispatch record (historical, 01:04)

- Workflow run **wf_1d1e4b32-864** (belay-sota-build): Scaffold → Fill(A/B/C/D disjoint) →
  Integrate → Gate(+1 repair retry). Script:
  ~/.claude/projects/-Users-taikicoleman-Development-conductor/4022295e-4935-4ad6-b17b-0babe2aa1c06/workflows/scripts/belay-sota-build-wf_1d1e4b32-864.js
- IF QUOTA DIES MID-RUN (projection ~01:32 at shared pace; reset 05:30): resume with
  Workflow({scriptPath: <above>, resumeFromRunId: "wf_1d1e4b32-864"}) — completed agents cached;
  check the run's journal.jsonl first. Scaffold+integrate commit incrementally; fill agents leave
  files on disk uncommitted.
- After gate GREEN → R-D: refute workflow (read-only) → harden → publish belay-harness + push →
  register belay MCP (claude mcp add) → fill HANDOFF-TEST.md TEST B → final report.

## Live-fire observation (01:10) — input for R-D refute

- User ran TEST A in another session → goal `belay-smoke` (goal_mr37ukbq019x1cmy) focused →
  belay's Stop hook BLOCKED the ORCHESTRATOR session too (stale-assess branch; complied with
  goal_assess: unmet 1/1, done.txt absent). Focus = global singleton; cwd-subtree scope matched.
- POLICY: owner session converges its own test goal; orchestrator conscripts itself only if the
  goal goes stale/blocked-again. R-D must verify: belay_loop_create pins sessionId in focus (per
  design, the JSON-RPC child CAN pin it — CLI couldn't) so loops don't rope in unrelated sessions
  unless intended; consider a config default (loop_scope: session|global).
- tokenroom CLAUDE.md updated by release agent: 0.6.0 STABLE published to latest, ADR-9 batched
  eval PASSED (eval/v3-wording/results/). Awaiting agent's own receipts before marking K2 GREEN.

## Known landmines (from prior brain)

- keyoku DEV checkout "~/Development/Keyoku Harness/keyoku" vs LIVE "~/Development/Keyoku/keyoku-harness"
  (LIVE is what ~/.claude.json mcpServers runs; LIVE ahead-5 of github; DEV was ~100 ahead of its github).
- 13 pre-existing typecheck errors in untouched keyoku files — don't rabbit-hole, report.
- npm token rotation still pending user-side (old token works; flag again).
- GEMINI_API_KEY plaintext in ~/.claude.json keyoku env — flagged to user before, still true.
- keyoku CLI spawn 160–264ms — too heavy for hooks; hooks read files directly (44ms). MCP server
  CAN spawn CLI (not hook-latency-bound).
- ~/.headroom + com.headroom.resume.plist stale artifacts — cleanup once pre-rename sessions end.

## Gate matrix log

- 00:47 baseline: tokenroom main==origin, npm rc published, 79-83 tests historically green.
  keyoku LIVE ahead-5 unpushed, 3 commits unreleased past v2.16.0, npm==2.16.0, dist built 07-01 22:04,
  288/288 at last gate. belay main==origin, 49 tests at last gate, NOT on npm, hooks NOT installed
  (doctor warn). R-A dispatched.
- 01:08 **K2 GREEN** (A2 done): ADR-9 batched eval RAN + GREEN (extended eval/v3-wording, 7
  scenarios × 28 cells, no external key, ≈$1-2; matrix at eval/v3-wording/results/
  2026-07-02-batched-post-0.3-wording.md; one non-blocking Haiku B-1 miss logged as ADR-20
  follow-up). tokenroom v0.6.0 STABLE: commits a7805e6+a7033f0, tag v0.6.0, CI 28575160035
  published WITH PROVENANCE (SLSA verified), dist-tags latest=0.6.0/next=rc.1, GitHub release
  cut, headroom-harness deprecated on registry. 83/83, invariants OK, doctor clean.
  ORCHESTRATION.md untouched + now gitignored. USER-SIDE: rotate npm token (rode old token in
  CI secret + local — urgent post-release; then gh secret set NPM_TOKEN + revoke old);
  rm -rf ~/.headroom when pre-rename sessions gone; launch announcement AWAITS explicit go
  (launch/RUNBOOK.md — publish ≠ promotion).
- NOTE 01:08: do NOT call tokenroom plan_resume for R-C insurance — resume.json is a single
  global slot currently holding the Polya session's queue (ZIP-848…); overwriting would clobber
  it. ORCHESTRATION.md carries the R-C resume path instead.
- 00:52 **K3 GREEN** (A3 done): belay armed live. 49/49 tests. Bundle additive verified on REAL
  settings.json (15→17 hook commands; all pre-existing preserved verbatim: sentai×4, keyoku×2,
  tokenroom×6, syukatsu×2, sentai-pull×1; non-hook keys byte-identical), idempotent (2nd run
  byte-identical). Doctor ALL [ok]. No-op default verified behaviorally against real state (no
  focus.json → Stop hook exit 0, 0 bytes out; PreToolUse same). No repo changes, no commits.
  Backup: scratchpad/settings.json.pre-install.bak. NOTE: doctor shows goals.json now 38 goals
  (was 37) — another session created one tonight; harmless. Belay idles until a goal is focused.

## 2026-07-02 — gate_mode 'defer' round (single writer, loop 1)

- **Shipped ADR-16 — gate_mode 'defer': deny-with-guidance + pending queue.** Changes:
  - `src/util.mjs`: CONFIG_DEFAULTS `gate_mode: 'ask'`; validation accepts only 'ask'|'defer',
    else warning + default (doctor surfaces it).
  - `src/gate.mjs`: decideGate stays PURE — classify() hits under `gate_mode:'defer'` return
    `{decision:'deny', reason: capReason(…deferred…queued…sandbox-safe…), defer:{class,tool_name,
    command≤500}}`, NOT passed through escalateForBypass (already deny → ADR-13 preserved).
    Spawn thin-budget branch stays 'ask' in both modes. Ask-mode output byte-identical
    (regression-tested no-config vs explicit gate_mode:'ask'). hookPreToolUse appends the queue
    entry (goalId from the keyoku read, sessionId from the payload) in its OWN try/catch — a
    failed append never drops the deny — and stdout JSON shape is unchanged (.defer never leaks).
  - NEW `src/pending.mjs`: $BELAY_DIR/pending.json `{pending:[{id,ts,class,tool_name,command,
    goalId,sessionId}]}`, id = sha256(class\ncommand\ngoalId)[:12] dedupe, 0600/0700 atomic
    (state.mjs pattern), read-fresh-on-write; pendingSummary/clear/remove/CLI renderer.
  - Surfacing: `belay status` + compose.mjs buildStatus (→ belay_status MCP) gain
    `pending:{count,classes}`; converged-allow stop adds stderr `N deferred action(s) await
    approval — run 'belay pending'` (hookStop, decision untouched — ADR-12 no-path mirrored);
    new CLI `belay pending [--clear|--remove <id>]` in bin/belay.mjs + usage text.
  - Docs/version: docs/DECISIONS.md ADR-16 appended; README config block + gate bullet +
    PreToolUse table + "Defer mode" subsection + CLI + reads/writes table; CHANGELOG 0.3.0;
    package.json 0.3.0 (+ mcp.mjs SERVER_INFO and keyoku-client clientInfo lockstep — scaffold
    test asserts the served version IS the shipped version).
  - Tests: gate.test.mjs +6 (defer-deny for all 6 classes, stdout-shape, ask byte-identity,
    invalid gate_mode fallback+doctor warning, spawn-ask-in-defer, bypass-deny) and NEW
    pending.test.mjs +6 (dedupe, 0600 perms, 500-char cap, CLI list/remove/clear, status
    surfacing, queue-never-consulted + malformed-file degrade). NEW standalone convergence
    probe test/fixtures/defer-mode-check.mjs (no runner; exit 0 = pass).
- **Result: `npm test` 187/187 GREEN** (was 174 baseline) and defer-mode-check.mjs exit 0.
  No commits, no publish, real ~/.belay and ~/.keyoku untouched (fixtures only).
