import { spawnSync } from 'node:child_process';
import { install, configDir } from './install.mjs';
import { resolveTokenroom, stackHealth, renderStackHealth, claudeJsonPath } from './stack.mjs';

// `belay bundle` — one command that wires the whole autonomous stack:
//   1) tokenroom (resource awareness) — detect its bin, invoke its own installer
//   2) keyoku    (goal convergence MCP) — verify it is registered (READ-ONLY; never touch it)
//   3) belay     (Stop + PreToolUse + SessionStart hooks, plus `claude mcp add belay` MCP
//                 registration) — install additively (preserve every other hook)
// Idempotent and re-runnable. Everything belay writes goes through the existing additive
// install path, so tokenroom's (and anyone else's) hooks are never clobbered.

/** Run tokenroom's installer, forwarding --config-dir (and --dry-run) so it targets the
 *  same place belay does. Returns a short status string; never throws. */
function runTokenroomInstall(tr, dir, dry) {
  const args = [...tr.args, 'install', ...(dry ? ['--dry-run'] : []), '--config-dir', dir];
  try {
    const r = spawnSync(tr.exec, args, { encoding: 'utf8' });
    for (const stream of [r.stdout, r.stderr]) {
      if (stream) for (const line of stream.split('\n')) if (line.trim()) console.log('     | ' + line);
    }
    if (r.error) return `could not run tokenroom installer (${r.error.message}) — install tokenroom manually, then re-run`;
    return r.status === 0 ? 'tokenroom installer completed' : `tokenroom installer exited ${r.status} — check its output above`;
  } catch (e) {
    return `could not run tokenroom installer (${e.message}) — install tokenroom manually, then re-run`;
  }
}

export function bundle(argv = []) {
  const dry = argv.includes('--dry-run');
  const dir = configDir(argv);

  console.log(`${dry ? '[dry-run] ' : ''}belay bundle — wiring the autonomous stack (tokenroom + keyoku + belay)`);
  console.log(`config dir: ${dir}\n`);

  // ── leg 1: tokenroom (resource awareness) ──
  console.log('1) tokenroom  (resource awareness — feeds budget to belay)');
  const tr = resolveTokenroom(argv);
  if (!tr.resolvable) {
    if (tr.badPath) console.log(`   - the given --tokenroom path does not exist: ${tr.badPath}`);
    console.log('   - not found on PATH, and no --tokenroom <path> / $TOKENROOM_BIN given.');
    console.log('     install tokenroom first: https://github.com/tyejcoleman/tokenroom');
    console.log('       (then re-run `belay bundle`, or pass --tokenroom <path-to-tokenroom.mjs>)');
    console.log('     continuing without it — belay still runs; budget just reads as UNKNOWN.');
  } else {
    console.log(`   - found: ${tr.label}`);
    console.log(`   - ${dry ? '[dry-run] would run' : 'running'} its installer (additive, its own concern)…`);
    console.log('     ' + runTokenroomInstall(tr, dir, dry));
  }

  // ── leg 2: keyoku (goal convergence MCP) — READ-ONLY verification ──
  console.log('\n2) keyoku  (goal convergence MCP — the goals belay drives)');
  const k = stackHealth(argv).keyoku;
  if (k.registered) {
    const vtxt = k.version == null ? 'version not findable (set KEYOKU_INSTALL to verify the >=2.7 <3 pin)' : k.inRange ? `keyoku ${k.version}, in range >=2.7 <3` : `keyoku ${k.version} — OUTSIDE the pinned range >=2.7 <3 (re-verify the file-layout contract)`;
    console.log(`   - MCP server registered in ${claudeJsonPath()} (${vtxt})`);
  } else {
    console.log(`   - MCP server NOT registered in ${claudeJsonPath()}.`);
    console.log('     belay has nothing to drive until a keyoku goal is focused — register keyoku, then re-run.');
  }
  console.log('   - (verification only — belay never modifies keyoku registration or restarts it)');

  // ── leg 3: belay (Stop + PreToolUse + SessionStart hooks + MCP registration) ──
  // install() prints its own section, is additive + idempotent (preserves tokenroom's and
  // every other hook), registers the belay MCP server via the official `claude mcp add`
  // (skipped in sandboxed config dirs / with --no-mcp), and refuses the npx cache on its own.
  console.log('\n3) belay  (Stop + PreToolUse + SessionStart autonomy loop + MCP server)');
  install(argv);

  // ── summary + next steps ──
  const h = stackHealth(argv);
  console.log('\n─ stack health ─────────────────────────────────────────────');
  for (const line of renderStackHealth(h)) console.log(line);

  const ready = h.belay.stop && h.belay.preToolUse && h.keyoku.registered;
  console.log('\n─ next steps: arm an autonomous loop ───────────────────────');
  console.log('  1. Create a Keyoku goal with MACHINE-CHECKABLE success criteria (keyoku goal_create).');
  console.log('  2. Focus it (keyoku goal_focus) — this scopes the loop to this session / cwd.');
  console.log('  3. Set the goal autonomy to `autonomous`.');
  console.log('  4. Run `belay doctor` to confirm all three legs are green.');
  console.log('  (or do 1–3 as one confirmed act: the `belay_loop_create` MCP tool creates,');
  console.log('   focuses, and arms the loop through keyoku\'s own process.)');
  console.log('  Then just work: belay holds the session on the goal until it converges,');
  console.log('  and routes irreversible/external actions (push, publish, sends) to you.');
  console.log(
    ready
      ? '\nstack is wired. Focus an autonomous goal and go.'
      : '\nfinish the warnings above (install tokenroom / register keyoku / re-run bundle), then you are armed.'
  );
}
