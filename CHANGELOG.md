# Changelog

## Unreleased — adversarial-refute hardening

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
