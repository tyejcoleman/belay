# Changelog

> **Renamed `conductor` → `belay` (ADR-8).** The command/bin is now `belay`
> (`bin/belay.mjs`), the npm package is **`belay-harness`** (bare `belay` is taken), the
> state dir is `~/.belay` (env `BELAY_DIR`), and block/ask reasons carry the `[belay]`
> prefix. `private: true` was removed so the package is publishable. The metaphor: the
> belayer feeds rope so the climber keeps ascending and arrests the fall — the Stop hook
> feeds rope, the PreToolUse gate is the fall-arrest. **Entries below this line predate the
> rename and name the tool "conductor"; they are kept verbatim as accurate history.**

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
