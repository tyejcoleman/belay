import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { belayDir } from './util.mjs';

// `belay selftest` — the hook-contract canary. belay's enforcement rides Claude Code's hook
// contract, a surface belay does not control (and which has broken before — bypassPermissions
// silently auto-yes'd "ask"). This proves TWO things: (1) the enforcement CODE PATH is intact on
// THIS install — spawn the real Stop + PreToolUse hooks against a throwaway world and confirm
// they block / arrest; and (2) the LIVE harness is actually invoking the hooks — read the real
// decisions journal for recent hook activity. A broken install or a silently-dead hook shows up
// here instead of as an enforcement gap nobody noticed.

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'belay.mjs');
const iso = (sec) => new Date(sec * 1000).toISOString();

/** A throwaway keyoku world with one focused, autonomous, unconverged goal. */
function tempWorld() {
  const base = mkdtempSync(join(tmpdir(), 'belay-selftest-'));
  const home = { keyoku: join(base, 'keyoku'), tokenroom: join(base, 'tokenroom'), belay: join(base, 'belay'), config: join(base, 'claude') };
  for (const d of Object.values(home)) mkdirSync(d, { recursive: true });
  mkdirSync(join(home.keyoku, 'observations'), { recursive: true });
  const now = Math.round(Date.now() / 1000);
  const goal = { id: 'selftest_goal', slug: 'belay-selftest', objective: 'canary', criteria: [{ id: 'c1', description: 'canary criterion' }], constraints: [], autonomy: 'autonomous', maxIterations: 50, usedIterations: 0, status: 'active', createdAt: iso(now - 60), lastAssessedAt: iso(now - 30) };
  writeFileSync(join(home.keyoku, 'goals.json'), JSON.stringify([goal]));
  writeFileSync(join(home.keyoku, 'focus.json'), JSON.stringify({ goalId: 'selftest_goal', goalSlug: 'belay-selftest', cwd: '/selftest', sessionId: 'selftest-sess', at: iso(now - 20) }));
  writeFileSync(join(home.keyoku, 'observations', 'selftest_goal.jsonl'), JSON.stringify({ goalId: 'selftest_goal', unmet: ['c1'], summary: 'unmet', at: iso(now - 30) }) + '\n');
  return { base, home };
}

function hook(home, args, payload) {
  const env = { ...process.env, KEYOKU_HOME: home.keyoku, TOKENROOM_DIR: home.tokenroom, BELAY_DIR: home.belay, CLAUDE_CONFIG_DIR: home.config };
  delete env.KEYOKU_INSTALL;
  delete env.CLAUDE_JSON;
  return spawnSync(process.execPath, [BIN, ...args], { input: JSON.stringify(payload), encoding: 'utf8', env });
}
const gated = (r) => {
  try {
    return ['ask', 'deny'].includes(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision);
  } catch {
    return false;
  }
};
const P = { session_id: 'selftest-sess', cwd: '/selftest' };

/** Run the canary. Returns { ok, checks:[{name,pass}], liveness:{last_decision_min, sessions_seen} }. */
export function selftest() {
  const checks = [];
  const w = tempWorld();
  try {
    const stop = hook(w.home, ['hook', 'stop'], P);
    let stopOk = false;
    try {
      stopOk = JSON.parse(stop.stdout).decision === 'block';
    } catch {
      /* not a block */
    }
    checks.push({ name: 'Stop hook BLOCKS an unconverged autonomous goal (the rope)', pass: stop.status === 0 && stopOk });

    checks.push({ name: 'PreToolUse gate HOLDS `git push` (the fall-arrest)', pass: gated(hook(w.home, ['hook', 'pre-tool-use'], { ...P, tool_name: 'Bash', tool_input: { command: 'git push origin main' } })) });
    checks.push({ name: "fall-arrest holds behind a shell wrapper (sh -c 'npm publish')", pass: gated(hook(w.home, ['hook', 'pre-tool-use'], { ...P, tool_name: 'Bash', tool_input: { command: "sh -c 'npm publish'" } })) });

    const benign = hook(w.home, ['hook', 'pre-tool-use'], { ...P, tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    checks.push({ name: 'benign command passes untouched (no over-gating)', pass: benign.status === 0 && benign.stdout.trim() === '' });
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }

  let last_decision_min = null;
  let sessions_seen = 0;
  try {
    const parsed = readFileSync(join(belayDir(), 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const times = parsed.map((d) => Date.parse(d.at)).filter(Number.isFinite);
    if (times.length) last_decision_min = Math.round((Date.now() - Math.max(...times)) / 60000);
    sessions_seen = new Set(parsed.map((d) => d.session_id)).size;
  } catch {
    /* no journal */
  }

  return { ok: checks.every((c) => c.pass), checks, liveness: { last_decision_min, sessions_seen } };
}

export function selftestCommand() {
  const r = selftest();
  console.log('belay selftest — is the enforcement code path live on THIS install?\n');
  for (const c of r.checks) console.log(`  [${c.pass ? 'ok' : 'FAIL'}] ${c.name}`);
  console.log('');
  if (r.liveness.last_decision_min == null) console.log('  [warn] no production decisions journaled yet — the live harness has not exercised the hooks on this machine');
  else console.log(`  [ok] live harness: hooks last fired ${r.liveness.last_decision_min}m ago across ${r.liveness.sessions_seen} session(s) — they ARE wired into the running harness`);
  console.log(`\n  ${r.ok ? 'PASS — belay blocks and arrests correctly on this install.' : 'FAIL — the enforcement path is broken here; re-run `belay install` and check node/paths.'}`);
  if (!r.ok) process.exitCode = 1;
}
