import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'belay.mjs');
export const nowSec = () => Math.round(Date.now() / 1000);
export const iso = (sec) => new Date(sec * 1000).toISOString();

/** Fresh isolated homes for every synthetic world. */
export function homes() {
  const base = mkdtempSync(join(tmpdir(), 'belay-'));
  return { base, keyoku: join(base, 'keyoku'), tokenroom: join(base, 'tokenroom'), belay: join(base, 'belay'), config: join(base, 'claude') };
}

export const env = (h) => ({
  ...process.env,
  KEYOKU_HOME: h.keyoku,
  TOKENROOM_DIR: h.tokenroom,
  BELAY_DIR: h.belay,
  CLAUDE_CONFIG_DIR: h.config,
});

/** Spawn the real bin — the tests exercise the exact process the harness runs. */
export function run(h, args, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
    encoding: 'utf8',
    env: env(h),
  });
}

export const goal = (over = {}) => ({
  id: 'goal_test1',
  slug: 'ship-widget',
  objective: 'ship the widget',
  criteria: [
    { id: 'c1', description: 'tests green' },
    { id: 'c2', description: 'deployed to prod' },
  ],
  constraints: [],
  autonomy: 'autonomous',
  maxIterations: 50,
  usedIterations: 3,
  status: 'active',
  createdAt: iso(nowSec() - 3600),
  lastAssessedAt: iso(nowSec() - 120),
  ...over,
});

export const focusFor = (over = {}) => ({ goalId: 'goal_test1', goalSlug: 'ship-widget', cwd: '/tmp/proj', at: iso(nowSec() - 60), ...over });

export const obs = (over = {}) => ({ goalId: 'goal_test1', kind: 'assessment', summary: '2 of 3 criteria unmet', unmet: ['c1', 'c2'], id: 'obs_x', at: iso(nowSec() - 120), ...over });

export function writeKeyoku(h, { goals, focus, obsLines, paused } = {}) {
  mkdirSync(join(h.keyoku, 'observations'), { recursive: true });
  if (paused) writeFileSync(join(h.keyoku, 'paused'), '');
  if (goals !== undefined) writeFileSync(join(h.keyoku, 'goals.json'), typeof goals === 'string' ? goals : JSON.stringify(goals, null, 2));
  if (focus !== undefined) writeFileSync(join(h.keyoku, 'focus.json'), typeof focus === 'string' ? focus : JSON.stringify(focus));
  if (obsLines) {
    const gid = (obsLines.find((l) => typeof l === 'object' && l?.goalId) ?? {}).goalId ?? 'goal_test1';
    writeFileSync(join(h.keyoku, 'observations', `${gid}.jsonl`), obsLines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
}

export function writeTokenroom(h, { leftPct = 72, resetsInMin = 180, estTokens = 230000, updatedAgoSec = 30 } = {}) {
  mkdirSync(h.tokenroom, { recursive: true });
  writeFileSync(
    join(h.tokenroom, 'state.json'),
    JSON.stringify({
      schema: 'resource-state/v0',
      updated_at: nowSec() - updatedAgoSec,
      windows: { five_hour: { used_pct: 100 - leftPct, resets_at: nowSec() + resetsInMin * 60 } },
      burn: { est_tokens_left: estTokens },
    })
  );
}

/**
 * Write profiles.json in tokenroom's REAL shape (src/accounts.mjs):
 *   { profiles: { <label>: { keys, last_seen, last_windows_snapshot:{ at, five_hour:{used_pct,resets_at} } } } }
 * Accepts a per-label options bag: { left_pct|leftPct, updated_at|at|updatedAgoSec,
 * resetsInMin|resetsAt, keys }. Kept back-compatible with the old
 * `{ work: { left_pct, updated_at } }` call sites — they now exercise the real contract.
 */
export function writeProfiles(h, profiles) {
  mkdirSync(h.tokenroom, { recursive: true });
  const out = {};
  for (const [label, o = {}] of Object.entries(profiles)) {
    const at = o.at ?? o.updated_at ?? nowSec() - (o.updatedAgoSec ?? 60);
    const leftPct = o.leftPct ?? o.left_pct ?? 0;
    out[label] = {
      keys: o.keys ?? [`key-${label}`],
      last_seen: at,
      last_windows_snapshot: {
        at,
        five_hour: { used_pct: 100 - leftPct, resets_at: o.resetsAt ?? nowSec() + (o.resetsInMin ?? 180) * 60 },
      },
    };
  }
  writeFileSync(join(h.tokenroom, 'profiles.json'), JSON.stringify({ profiles: out }));
}

export const stopPayload = (over = {}) => ({ session_id: 's1', cwd: '/tmp/proj', stop_hook_active: false, ...over });

export const toolPayload = (over = {}) => ({ session_id: 's1', cwd: '/tmp/proj', tool_name: 'Bash', tool_input: { command: 'ls' }, ...over });
