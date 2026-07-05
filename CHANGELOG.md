# Changelog

> **Renamed `conductor` → `belay` (ADR-8).** The command/bin is now `belay`
> (`bin/belay.mjs`), the npm package is **`belay-harness`** (bare `belay` is taken), the
> state dir is `~/.belay` (env `BELAY_DIR`), and block/ask reasons carry the `[belay]`
> prefix. `private: true` was removed so the package is publishable. The metaphor: the
> belayer feeds rope so the climber keeps ascending and arrests the fall — the Stop hook
> feeds rope, the PreToolUse gate is the fall-arrest. **Entries below this line predate the
> rename and name the tool "conductor"; they are kept verbatim as accurate history.**

## 0.4.0 — hardened arrest, intelligence layer, self-observability

A four-reviewer audit + refute pass drove the fall-arrest from bypassable to wrapper-proof,
added the coaching layer that makes a weaker model's autonomous runs bounded/safe/honest, and
gave belay eyes on its own enforcement. ADR-18..22. 240 tests (from 204). Highlights below.

### Catch-mode — the denylist becomes semantically complete (ADR-17 ext)

- **`slm_catch`** (config, default false; requires `slm_enabled`): the mirror of the refine
  adjudicator. Stage 1 is a denylist and is fundamentally incomplete (`$(echo git) push`,
  `eval $var`, a binary not in the table); catch-mode consults the learned daemon on a stage-1
  MISS and lets it ADD an ask/defer for a dangerous command the denylist can't express. Safe to
  trust an untrusted daemon here because catch only ever ADDS friction — an absent/slow/malformed
  daemon can at worst over-ask, never fail open (byte-identical to catch off on any failure).

### System v2 — belay watches its own enforcement (ADR-22)

- **`belay insights`** mines belay's own decision journal + retros + pending into a read on how
  the harness is actually behaving: decisions bucketed by meaning (idle / released / HELD / GATED),
  the no-op rate, fall-arrest acts by class, loop outcomes/thrash, and hook liveness. The
  PreToolUse gate now journals its ask/deny acts (only when it acts — hot path untouched) so the
  fall-arrest is measurable. Dogfooded on the live journal: 94% correct no-op across 28 sessions.
- **`belay selftest`** — the hook-contract canary: spawns the real hooks against a throwaway world
  and proves the enforcement path blocks/arrests on THIS install (incl. behind a shell wrapper),
  then confirms from the real journal that the live harness is actually firing the hooks. Turns
  "hope the hooks fire" into "know they fire" — the #1 real-world risk (belay rides a hook contract
  it doesn't control) now self-checks.
- **`retro_auto_push`** (config, default false) files each disarm's retro into keyoku's knowledge
  store, closing the learning loop.

### Hardening + intelligence pass — audit gaps closed (ADR-18..21)

Driven by a 4-reviewer adversarial audit (hook-path, MCP/loops, effectiveness, test quality).

- **Fall-arrest is now wrapper-proof (ADR-18).** The command classifier scans the whole string
  for the dangerous binary instead of walking the leading token of each `&&`/`;` segment, so
  `sh -c 'git push'`, `bash -lc`, `eval`, backticks, `$(…)`, `(subshell)`, a lone `&`, and
  `env FOO=bar git push` no longer silently allow an irreversible action. Also now caught:
  `gh api` non-GET/field writes, `npm publish` behind value-taking globals, `curl/wget`
  DELETE/PATCH and bundled/attached flags (`-sX POST`, `-da=1`, `-Tfile`), `find -exec rm -rf`,
  and case variants (`GIT`/`RM`). New config `danger_binaries` (`{binary:[subs]|['*']}`) extends
  the built-in table (docker/kubectl/terraform/… defaults) for any stack, no code change. New
  property/fuzz suite `test/gate-fuzz.test.mjs` covers the wrapper × binary × flag space.
- **No self-liberation, no verifier tampering (ADR-19).** New HARD `loop control` gate class
  routes `belay_loop_disarm` + keyoku `goal_unfocus`/`goal_update`/`goal_converge`/`goal_delete`
  to the human while a loop is focused; the ADR-13 bypass deny no longer advertises
  disarm-then-retry (which laundered the arrest).
- **Install/uninstall can no longer destroy settings.json (ADR-20).** Refuse to overwrite a
  present-but-unparseable settings.json; uninstall backs up first; both write atomically;
  re-install refreshes a stale hook path; doctor FAILs a registered hook whose path is gone.
- **The intelligence layer (ADR-21).** Thrash detection (differential "change strategy" guidance
  when the same criteria won't move), final-continuation wrap-up (clean landing instead of a
  silent release), prioritization ("pick ONE"), SessionStart compaction re-briefing of a live
  loop, and an orphaned-loop proposal (S6) — all within the never-crash hooks, none touching the
  ADR-6 termination proof. New config `thrash_threshold` (default 3).
- **MCP surface hardening:** `belay_status`/`belay_loop_list` cap file-controlled array counts
  (context-flood defense); `keyoku-client` races `exit`/`close` so a lingering grandchild can't
  wedge a tool call; `loop_create` failures carry may-have-landed guidance; MCP `initialize`
  negotiates a supported protocol version.
- **Adversarial refute hardening (post-audit):** an independent pass found and this closed —
  self-liberation via `mcp__keyoku__goal_focus` (re-focus off the arrest goal) and via one-line
  control-file writes (`touch ~/.keyoku/paused`, `> …/focus.json`, `> ~/.belay/config.json`), now
  both gated (goal_focus in `loop control`; a new HARD `control-file tampering` class); a
  fail-OPEN where `unmetDetail`'s O(unmet×criteria) join could time out the Stop hook on a
  pathological goal (now O(n) via a Map + a 500-id cap, 21.6s→12ms); a silent hook-drop when
  `settings.json` had a non-object `hooks` (now refused); and shell line-continuation
  (`git \⏎push`) slipping the classifier (now normalized). New regression tests for each.
- **Phase 3 — deeper autonomy (ADR-21):** an **adaptive budget** — a loop stuck on the same
  unmet set past `thrash_release` (default 8) gets one model-visible escalation block ("stand
  down / escalate") then releases early, so a hopeless loop stops at ~8 continuations instead of
  grinding all 25 (still an allow, so the ADR-6 block bound is untouched — termination is
  tighter). A **learning flywheel**: every disarm captures a loop retro (thrash / convergence /
  continuations) to `~/.belay/retros.jsonl` — telemetry belay alone holds — and
  `belay loop retro <goal>` files it into keyoku's knowledge store (via keyoku's own process) so
  it grounds future `goal_assess` guidance. And a **probe-driven e2e** (`test/probe-e2e.test.mjs`
  + a `probe-keyoku` fixture that actually RUNS the probe) that proves the whole loop flips from
  block to allow on a real exit-code change, not a hand-written observation.
- Version intentionally NOT bumped here; folds into the next release.

### Stage-2 learned-adjudicator hook — refine-only, fail-safe-first (ADR-17)

- **New config keys** `slm_enabled` (default **false**), `slm_url` (default
  `http://127.0.0.1:8642/adjudicate`), `slm_timeout_ms` (1500, floor 100 — the L2-5
  lesson) and `slm_min_confidence` (0.9, range 0..1) — all validated defensively; bad
  values fall back to defaults with a doctor warning.
- **Stage 2 in `hookPreToolUse` only** (`decideGate` stays pure and is behaviorally
  untouched with `slm_enabled: false`): after a stage-1 hit on a **SOFT** class
  (`rm -rf outside cwd`, `network write`, config `ask_patterns` classes), the hook POSTs
  the CGS `GATE-ADJUDICATOR-PLAN.md` §3 request to the local adjudicator daemon
  (zero-dep `node:http`, AbortController hard timeout) and merges the verdict through
  the new pure `mergeVerdict`: a well-formed, non-abstaining `allow` at/above
  `slm_min_confidence` passes silently (nothing queued); a `defer` verdict maps onto the
  ADR-16 defer-queue deny (only in `gate_mode: 'defer'`); anything else — malformed,
  abstain, low confidence, `ask`, timeout, non-200, bad JSON, daemon absent — degrades
  to the stage-1 decision **byte-identically**.
- **HARD classes** (`git push`, `npm publish`, `gh mutation`, `external send/publish`;
  exported as `HARD_CLASSES` alongside `SOFT_CLASSES`) are never sent to the daemon and
  can never be unlocked — a forged `{verdict:'allow', confidence:1}` changes nothing.
  Stage 2 also never runs under `bypassPermissions` (the ADR-13 deny stays final) or for
  the spawn-budget ask. The daemon is **untrusted input**: structural response
  validation, 64KB body cap, and ADR-7 sanitization of any rationale.
- **`test/gate-slm.test.mjs`** — 17 tests against an in-test mock daemon: byte-identical
  output with `slm_enabled: false`, byte-identical stage-1 fallback with the daemon
  STOPPED (the plan's convergence criterion c7), HARD-class forgery resistance, the
  calibrated SOFT-allow path (incl. defer-mode un-queueing), every degrade shape, the §3
  request contract, and `mergeVerdict` unit cases.
- Version intentionally NOT bumped: 0.4.0 ships when the trained adapter lands.

## 0.3.0 — 2026-07-02

### gate_mode 'defer' — deny-with-guidance + a pending queue for one batched review (ADR-16)

- **New config field `gate_mode`** (`'ask'` | `'defer'`, default `'ask'`; anything else
  falls back to the default with a doctor warning). In `'ask'` mode the gate is
  byte-identical to 0.2.0. In `'defer'` mode, irreversible/external classes under an
  autonomous goal are **DENIED with guidance** (`'<class>' action deferred under
  autonomous goal — queued for batched human approval at convergence; continue with
  sandbox-safe work`) instead of stalling an unattended loop on an `ask` nobody will
  answer. Deny is strictly SAFER than ask — the arrest is never weakened, and under
  `bypassPermissions` defer already denies, so ADR-13's semantics are preserved.
- **Pending queue** — each deferred action is appended to `~/.belay/pending.json`
  (`{id, ts, class, tool_name, command (capped 500), goalId, sessionId}`; deduped by a
  content hash of class+command+goalId so a retried action queues once; dir 0700 / file
  0600 / atomic writes, the state.mjs pattern). The queue is **presentation metadata
  only**: no gate or stop decision ever reads it (the ADR-12 no-path rule, mirrored).
- **Surfacing** — `belay status` and `belay_status` gain `pending: {count, classes}`;
  a converged-goal stop that is allowed adds a stderr reminder (`N deferred action(s)
  await approval — run 'belay pending'`); new CLI `belay pending` lists the queue
  human-readably, `--clear` empties it, `--remove <id>` drops one entry.
- **Unchanged** — the spawn-tools thin-budget branch stays `'ask'` in both modes (it is
  a budget question, not irreversibility); default/ask-mode gate output is
  byte-identical for the same inputs (regression-tested).
- New standalone convergence probe `test/fixtures/defer-mode-check.mjs` (exit 0 = pass,
  runs with no test runner) plus defer/queue regression tests in `test/gate.test.mjs`
  and `test/pending.test.mjs`.

## 0.2.0 — 2026-07-02

The SOTA meta-harness release: belay becomes MCP-accessible, creates and runs autonomous
convergence loops through keyoku's own process, and proposes loops from live state
signals — then survived a 23-agent adversarial refute (13 confirmed findings + 4 audit
findings), every one fixed below with a regression test.

### The SOTA surface (ADR-9..12)

- **`belay mcp`** — hand-rolled newline-stdio JSON-RPC 2.0 MCP server (zero deps,
  tokenroom pattern), registered by `belay install` via `claude mcp add`. Seven tools:
  `belay_status` (stack × budget × goal × loop × counters × the would-block verdict, every
  figure file-sourced), `belay_loop_create` (objective → created → focused → armed in one
  confirmed call, all keyoku writes through keyoku's own registered server process —
  ADR-10), `belay_loop_list`, `belay_loop_pause`/`resume`/`disarm` (pause suspends the
  rope, never the fall-arrest — ADR-12), and `belay_propose` (S1–S5 signals: deferred work
  ready, unfocused autonomous goals, stale-converged, budget-reset, keyoku-ripe — advisory
  only, never auto-armed — ADR-11).
- **SessionStart briefing** — open proposals surfaced as `additionalContext` (sanitized,
  byte-capped ≤1.5KB), zero proposals → zero output.
- **CLI twins** — `belay loop create|list|pause|resume|disarm`, `belay propose`; CLI and
  MCP render from the same compose/handler layer so they cannot drift. `belay status` and
  `belay doctor` show loop arm/pause state, proposal counts, and the loops/proposals
  self-checks.

### Refute-round hardening (all 17 findings fixed, each with a fail-before/pass-after test)

- **bypassPermissions escalates ask → deny (ADR-13, live TEST-A finding):** under
  `defaultMode: bypassPermissions` the harness auto-resolves "ask" — the fall-arrest was a
  silent no-op. While an autonomous goal is focused, would-be asks now DENY with
  instructions (run outside bypass, or `belay_loop_disarm`); doctor warns on the setting.
- **Loops are session-scoped by default (ADR-14, live conscription incident):**
  `belay_loop_create` requires `session_id` (pinned in `goal_focus`) unless
  `scope:'global'` is explicitly passed; `loop_scope` recorded as provenance; the tool
  description now says what the tool actually does.
- **Child stderr withheld from MCP-visible errors (L2-3):** a crashing keyoku child that
  echoes its registered env (API keys) can no longer leak it into the model-visible
  transcript — transport errors carry only belay-authored text, stderr is drained and
  never kept, logged, or surfaced.
- **Budget attribution can never serve another account's numbers (L4-1):** `readBudget`
  mirrors tokenroom's quotaScope — an unmapped session on a ≥2-account machine gets
  quota WITHHELD (UNKNOWN, permissive for stops, no spawn gating) instead of the
  last-writer-wins top-level pointer.
- **`belay_status` never fabricates (L4-2):** with no `session_id` and no session-pinned
  focus, counters come back `unattributed` (withheld) and the verdict is explicitly
  marked zero-history — never a phantom `0/25` + opposite verdict.
- **Disarm cannot blind-clear a concurrent arm's focus (L2-1):** the focused-goal match is
  re-read after the keyoku child spawn, immediately before the argument-less
  `goal_unfocus` RPC.
- **ADR-6 termination bound hardened (L1-1/L1-2/L1-3, ADR-15):** state.json writes are
  per-entry read-modify-write over the freshest copy (a concurrent stop can no longer
  revert a just-persisted counter); a fresh `lastAssessedAt` attesting an OLDER
  observation tail blocks once demanding `goal_assess` instead of releasing on stale
  ground truth; `belay_loop_resume` is refused unless paused (one stale-block refund per
  explicit pause→resume cycle) and a session-scoped re-arm resets only the arming
  session's counters.
- **Scope-ordered keyoku server resolution (L2-2):** current project block first, then
  user scope — never another project's `/keyoku/i`-named command; exact name beats
  substring within a scope.
- **Post-arm writes guarded (L2-4):** an FS failure after keyoku focus succeeded returns
  `{ok:false, step:'arm', steps}` with repair guidance (or armed-but-degraded flags) —
  never a bare `-32603` that invites a duplicate-goal retry.
- **`keyoku_call_timeout_ms` floors at 1000ms (L2-5):** a config value of 0 no longer
  makes every keyoku RPC time out instantly.
- **Byte-true caps (L3-1):** `capReason` caps UTF-8 bytes (code-point safe), so multibyte
  file-controlled text can no longer blow the documented 1.5KB/2KB budgets.
- **Hermetic gates are honest (audit F1):** `claudeJsonPath` no longer falls through an
  empty `CLAUDE_CONFIG_DIR` to the real `~/.claude.json`; the scaffold gate fails loudly
  unless the fixture server answers — the suite can never silently pass against real
  keyoku.
- **Observability:** every evaluated Stop (including silent allows) journals one line to
  `~/.belay/decisions.jsonl` (self-capping); `belay status` warns when an active
  autonomous focus has no sessionId pin.
- **Packaging (audit F3/F4):** the npm tarball now ships `docs/` and `CHANGELOG.md`; the
  shipped version's changelog matches the shipped code, and a scaffold test pins
  `SERVER_INFO.version` to `package.json`.

### Renamed to belay + one-command bundle + autonomous e2e proof

- **Rename (ADR-8):** `conductor` → `belay` swept across bin, src, tests, help text, config
  path, env var (`CONDUCTOR_DIR` → `BELAY_DIR`), state dir (`~/.conductor` → `~/.belay`),
  and block-reason prefix (`[conductor]` → `[belay]`). npm name `belay-harness`; publishable.
- **`belay bundle`** — one command that wires the whole autonomous stack: detects & invokes
  tokenroom's installer (or tells you to install it first), verifies the keyoku MCP server is
  registered (read-only; never modifies it), installs belay's own Stop + PreToolUse hooks
  additively (preserving tokenroom's and any others), and prints a three-leg status summary
  plus the exact next steps to arm an autonomous goal. `--dry-run` supported; idempotent.
- **`belay doctor`** now opens with a full-stack health view (tokenroom present+installed?,
  keyoku present+version-in-range?, belay hooks registered?) before the detailed self-checks.
- **`test/autonomous-e2e.test.mjs`** — proves the self-driving loop end to end on temp state:
  a seeded autonomous goal with an unmet criterion makes the Stop hook block (loop continues);
  flipping to converged/0-unmet makes it allow (loop stops); the continuation counter is bounded
  (eventually allows); and a `git push` under the autonomous goal still asks for approval.

### Adversarial-refute hardening (first pass, 2026-07-01)

Seven confirmed bugs fixed (each with a spawn-based regression test that fails before,
passes after). See `docs/DECISIONS.md` ADR-5..7.

- **Scope match is one-way (ADR-5):** a session in an ANCESTOR of the goal's cwd (an
  orchestrator at the repo root, a shell at `/` or `$HOME`) is no longer held for a goal it
  is not driving. Dropped keyoku's bidirectional attribution for the blocking decision;
  guarded the trailing-slash strip.
- **Stop loop no longer capped at one continuation (ADR-6):** removed the blanket-allow on
  `stop_hook_active` (which capped forced continuations at one per turn, making
  `max_continuations` unreachable). The flag is no longer consulted at all; termination is
  anchored to conductor's own monotonic, durable per-(session, goal) counter so it does not
  depend on the harness setting the flag (ADR-4). Documented the termination argument (every
  blocking branch is counter-capped or one-shot, so ≤ `max_continuations + 1` blocks total).
- **Alt-profile parsing fixed:** `pickAltProfile`/`normalizeProfile` now read tokenroom's
  real `profiles.json` (`{profiles:{<label>:{keys, last_seen, last_windows_snapshot:{at,
  five_hour:{used_pct, resets_at}}}}}`) — `budget.alt` was always null against real data, so
  every alt-profile behavior was inert. Self-excludes by any of a profile's `keys[]`; drops
  post-reset readings. Test helper now writes the real shape.
- **`rm -rf` wrapper bypass closed:** a recursive+force rm is caught behind `sh -c`,
  `env VAR=x`, backticks, `$(…)`, `xargs`, `/bin/rm`, or quotes; unexpanded/absent targets
  route to the human (ask, not deny).
- **git/gh option-smuggling closed:** `git -C DIR push`, `git --git-dir=x push`,
  `gh -R repo pr merge`, `env FOO=bar git push` now classify correctly (token-based, not a
  binary-then-subcommand regex).
- **Injection/flood surface removed (ADR-7):** sibling-goal criteria descriptions/slug and
  the tokenroom label are sanitized (control chars stripped, per-item ≤120 chars, whole
  reason ≤2 KB, tame charset) before they land in the model-visible block reason.
- **Fresh-but-unassessed goal no longer silently released:** `unmetDetail` → null (UNKNOWN)
  is distinguished from `[]`; a fresh goal with no readable assessment gets one
  `goal_assess`-demanding block, then allows.

## 0.1.0 — 2026-07-01

Conductor v0 — the always-on goal loop for Claude Code, official surfaces only.

- **Stop hook** (`conductor hook stop`): blocks a stop while the focused Keyoku goal is
  autonomous, active, unmet, and budget allows; hands back unmet criteria with
  descriptions plus a tokenroom budget line (healthy / thin-descent / alt-profile
  switch advice). Allows on: `stop_hook_active`, no/mismatched focus, paused keyoku,
  human-in-the-loop autonomy, converged/blocked/abandoned, keyoku iteration budget
  exhausted, own continuation budget exhausted (25/session/goal), quota below the 3%
  floor with no fresh alt profile. Stale assessments (>60m) get exactly one
  "run goal_assess first" block.
- **PreToolUse gate** (`conductor hook pre-tool-use`): under an autonomous focus only —
  irreversible/external actions (git push, npm publish, gh mutations, rm -rf outside
  cwd, curl/wget writes to non-localhost, MCP send/publish tools) route to the human
  via permissionDecision "ask"; Task/Agent/Workflow spawns ask under <10% budget
  (conservative on stale readings). Configurable ask_patterns / allow_overrides.
- **CLI**: `install` (additive, idempotent, backed-up, refuses npx cache), `uninstall`
  (removes only conductor entries), `doctor` (keyoku layout self-check + version pin
  >=2.7 <3, tokenroom freshness, hook registration, config validity), `status`
  (focused goal + would-block verdict + counters).
- Zero dependencies, plain ESM, never-crash choke point, 0700/0600 state hardening.
- 33 tests (node:test, spawn-based) covering every decision branch + T2 installer
  round-trip against pre-existing tokenroom-style hooks.

Name note: `conductor-harness` is a placeholder; final npm name TBD, private until then.
