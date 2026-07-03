#!/usr/bin/env node
// Standalone convergence probe for gate_mode 'defer' (ADR-16) — NO test runner: run
// directly (`node test/fixtures/defer-mode-check.mjs`), exit 0 = pass, exit 1 + printed
// reason = fail. Builds hermetic temp fixture homes (mimicking test/helpers.mjs), spawns
// the REAL bin's PreToolUse hook against them, and asserts:
//   1. stdout is the hook JSON with permissionDecision 'deny' and a defer/queued reason
//   2. BELAY_DIR/pending.json now holds exactly one entry with class 'git push'
// Never touches ~/.belay or ~/.keyoku — everything lives under a mkdtemp dir, cleaned up.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'belay.mjs');
const base = mkdtempSync(join(tmpdir(), 'belay-defer-check-'));
const homes = { keyoku: join(base, 'keyoku'), tokenroom: join(base, 'tokenroom'), belay: join(base, 'belay'), config: join(base, 'claude'), proj: join(base, 'proj') };

const fail = (reason) => {
  console.error(`defer-mode-check FAIL: ${reason}`);
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
};

try {
  const nowIso = new Date().toISOString();
  // KEYOKU_HOME: a focused ACTIVE AUTONOMOUS goal pinned to this probe's session + cwd.
  mkdirSync(join(homes.keyoku, 'observations'), { recursive: true });
  writeFileSync(
    join(homes.keyoku, 'goals.json'),
    JSON.stringify([
      {
        id: 'goal_defer_check',
        slug: 'defer-check',
        objective: 'exercise gate_mode defer',
        criteria: [{ id: 'c1', description: 'probe passes' }],
        constraints: [],
        autonomy: 'autonomous',
        maxIterations: 50,
        usedIterations: 1,
        status: 'active',
        createdAt: nowIso,
        lastAssessedAt: nowIso,
      },
    ])
  );
  writeFileSync(join(homes.keyoku, 'focus.json'), JSON.stringify({ goalId: 'goal_defer_check', goalSlug: 'defer-check', cwd: homes.proj, sessionId: 'sess-defer-check', at: nowIso }));
  // BELAY_DIR: gate_mode 'defer'. TOKENROOM_DIR: present but empty (budget UNKNOWN — irrelevant here).
  mkdirSync(homes.belay, { recursive: true });
  writeFileSync(join(homes.belay, 'config.json'), JSON.stringify({ gate_mode: 'defer' }));
  mkdirSync(homes.tokenroom, { recursive: true });
  mkdirSync(homes.proj, { recursive: true });

  const env = { ...process.env, KEYOKU_HOME: homes.keyoku, TOKENROOM_DIR: homes.tokenroom, BELAY_DIR: homes.belay, CLAUDE_CONFIG_DIR: homes.config };
  delete env.KEYOKU_INSTALL; // hermeticity — same escape-hatch scrub as test/helpers.mjs env()
  delete env.CLAUDE_JSON;

  const r = spawnSync(process.execPath, [bin, 'hook', 'pre-tool-use'], {
    input: JSON.stringify({ session_id: 'sess-defer-check', cwd: homes.proj, permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }),
    encoding: 'utf8',
    env,
  });

  if (r.status !== 0) fail(`hook exited ${r.status} (stderr: ${r.stderr})`);
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    fail(`hook stdout is not JSON: ${JSON.stringify(r.stdout)}`);
  }
  const h = out?.hookSpecificOutput;
  if (h?.hookEventName !== 'PreToolUse') fail(`hookEventName is ${JSON.stringify(h?.hookEventName)}, expected 'PreToolUse'`);
  if (h?.permissionDecision !== 'deny') fail(`permissionDecision is ${JSON.stringify(h?.permissionDecision)}, expected 'deny'`);
  if (!/defer/i.test(h?.permissionDecisionReason ?? '') || !/queued/i.test(h?.permissionDecisionReason ?? '')) {
    fail(`reason does not mention defer + queued: ${JSON.stringify(h?.permissionDecisionReason)}`);
  }
  if ('defer' in (h ?? {}) || 'defer' in (out ?? {})) fail('the internal .defer routing field leaked into the hook stdout JSON');

  let queue;
  try {
    queue = JSON.parse(readFileSync(join(homes.belay, 'pending.json'), 'utf8'));
  } catch (e) {
    fail(`BELAY_DIR/pending.json unreadable: ${e.message}`);
  }
  if (!Array.isArray(queue?.pending) || queue.pending.length !== 1) fail(`pending.json holds ${queue?.pending?.length ?? 'no'} entries, expected exactly 1`);
  const entry = queue.pending[0];
  if (entry.class !== 'git push') fail(`queued entry class is ${JSON.stringify(entry.class)}, expected 'git push'`);
  if (entry.goalId !== 'goal_defer_check') fail(`queued entry goalId is ${JSON.stringify(entry.goalId)}, expected 'goal_defer_check'`);
  if (entry.sessionId !== 'sess-defer-check') fail(`queued entry sessionId is ${JSON.stringify(entry.sessionId)}, expected 'sess-defer-check'`);
  if (entry.command !== 'git push origin main') fail(`queued entry command is ${JSON.stringify(entry.command)}`);
  if (typeof entry.id !== 'string' || !entry.id) fail('queued entry has no id');

  console.log('defer-mode-check PASS: deny-with-guidance emitted, action queued once in pending.json');
  rmSync(base, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  fail(`unexpected error: ${e?.stack ?? e}`);
}
