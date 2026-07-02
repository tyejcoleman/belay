#!/usr/bin/env node
// conductor — always-on goal loop for Claude Code (official surfaces only).
// Reads Keyoku goal state and tokenroom budget state from their files; never spawns
// their processes, never runs probes, never touches credentials, never networks.

const [cmd, ...argv] = process.argv.slice(2);

switch (cmd) {
  case 'hook': {
    // Never-crash rule at the choke point (ADR-4, tokenroom ADR-5 spirit): whatever a
    // hook hits — corrupted state files, malformed stdin, a keyoku layout change — it
    // degrades to silence. A hook must never break the harness or wedge a session.
    try {
      if (argv[0] === 'stop') await (await import('../src/stop.mjs')).hookStop();
      else if (argv[0] === 'pre-tool-use') await (await import('../src/gate.mjs')).hookPreToolUse();
      // unknown hook events exit silently
    } catch {
      process.exitCode = 0;
    }
    break;
  }
  case 'install':
    (await import('../src/install.mjs')).install(argv);
    break;
  case 'uninstall':
    (await import('../src/install.mjs')).uninstall(argv);
    break;
  case 'doctor':
    (await import('../src/doctor.mjs')).doctor(argv);
    break;
  case 'status':
    (await import('../src/status.mjs')).status(argv);
    break;
  default:
    console.log(`conductor — always-on goal loop for Claude Code (reads Keyoku goals + tokenroom budget)

usage:
  conductor install [--dry-run] [--config-dir <dir>]   register the Stop + PreToolUse hooks (additive; preserves existing hooks)
  conductor uninstall [--config-dir <dir>]             remove only conductor's entries
  conductor status                                     current focused goal + would-block verdict + counters
  conductor doctor                                     keyoku layout self-check, tokenroom presence, hook registration, config validity
  conductor hook <stop|pre-tool-use>                   (hook commands — wired by install)

Conductor continues work WITHIN a session and advises across sessions; it never launches
headless runs and never touches credentials.`);
}
