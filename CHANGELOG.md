# Changelog

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
