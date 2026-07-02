import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, readConfig, tokenroomDir, belayDir } from './util.mjs';
import { keyokuHome, tailObservation, scopeMatch } from './keyoku.mjs';
import { configDir, MARK } from './install.mjs';
import { findKeyokuVersion, parseVersion, KEYOKU_RANGE, stackHealth, renderStackHealth } from './stack.mjs';

// `belay doctor` — one health view of the whole autonomous stack, then the ADR-1
// counterweight: we code against keyoku's FILES, not its process, so we ship a layout
// self-check that verifies the contract still holds on this machine (keyoku's store layer
// reserves a future SQLite swap; this is where that breaks loudly instead of silently
// no-opping forever).

export { findKeyokuVersion };

export function doctor(argv = []) {
  const lines = [];
  const say = (level, msg) => lines.push(`  [${level}] ${msg}`);

  // ── full-stack health (tokenroom · keyoku · belay), rendered from the shared checks ──
  console.log('belay doctor\n\nstack (tokenroom + keyoku + belay)');
  console.log(renderStackHealth(stackHealth(argv)).join('\n'));

  // ── keyoku layout self-check ──
  const home = keyokuHome();
  console.log(`\nkeyoku (${home})`);
  if (!existsSync(home)) {
    say('warn', 'keyoku home not found — belay idles (no goals to hold)');
  } else {
    say('ok', 'home exists');
    if (existsSync(join(home, 'paused'))) say('warn', "'paused' marker present — belay is a no-op until it is removed");

    const goalsRaw = (() => {
      try {
        return readFileSync(join(home, 'goals.json'), 'utf8');
      } catch {
        return null;
      }
    })();
    if (goalsRaw == null) say('warn', 'goals.json missing — no goals yet (fine on a fresh keyoku)');
    else {
      const goals = readJSON(join(home, 'goals.json'));
      if (!Array.isArray(goals)) say('FAIL', 'goals.json is not a JSON array — layout contract broken (keyoku store format changed?)');
      else {
        const bad = goals.filter((g) => !(g && typeof g === 'object' && typeof g.id === 'string' && typeof g.status === 'string' && typeof g.autonomy === 'string' && Array.isArray(g.criteria)));
        if (bad.length) say('FAIL', `goals.json: ${bad.length}/${goals.length} rows missing id/status/autonomy/criteria — layout contract broken`);
        else say('ok', `goals.json: ${goals.length} goals, all rows carry id/status/autonomy/criteria`);
        const focus = readJSON(join(home, 'focus.json'));
        if (!existsSync(join(home, 'focus.json'))) say('ok', 'no focus.json — nothing focused, belay idles');
        else if (!focus || typeof focus.goalId !== 'string') say('FAIL', 'focus.json present but unreadable/missing goalId — treated as no focus');
        else {
          const g = goals.find((x) => x && x.id === focus.goalId);
          if (!g) say('warn', `focus.json points at ${focus.goalId} which is not in goals.json — treated as no focus`);
          else {
            const scope = [focus.sessionId ? `session ${focus.sessionId}` : null, focus.cwd ? `cwd ${focus.cwd}` : null].filter(Boolean).join(', ') || 'unscoped (matches all)';
            say('ok', `focus: '${g.slug ?? g.id}' (status ${g.status}, autonomy ${g.autonomy}; ${scope})`);
            if (!scopeMatch(focus, focus.sessionId, focus.cwd ?? process.cwd())) say('warn', 'focus scope self-check failed (unexpected)');
            const obs = tailObservation(join(home, 'observations', `${focus.goalId}.jsonl`));
            if (!obs) {
              const freshAssess = typeof g.lastAssessedAt === 'string' && Date.parse(g.lastAssessedAt) > Date.now() - 60 * 60 * 1000;
              say('warn', `observations/${focus.goalId}.jsonl has no parseable line with an unmet[] — belay will ${freshAssess ? 'block ONCE demanding goal_assess (unmet-unknown), lastAssessedAt is still fresh' : 'take the stale-assess path (lastAssessedAt stale/absent)'}`);
            } else say('ok', `observation tail parses (unmet: ${Array.isArray(obs.unmet) ? JSON.stringify(obs.unmet) : 'absent'}, at ${obs.at ?? '?'})`);
          }
        }
        if (!existsSync(join(home, 'observations'))) say('warn', 'observations/ dir missing — unmet criteria unreadable (a fresh goal gets one goal_assess-demanding block; a stale one takes the stale-assess path)');
        else say('ok', `observations/ present (${readdirSync(join(home, 'observations')).length} goal logs)`);
      }
    }

    const kv = findKeyokuVersion();
    if (!kv || !kv.version) say('warn', 'keyoku package.json not findable (set KEYOKU_INSTALL to its install dir) — version pin >=2.7 <3 unverified');
    else {
      const v = parseVersion(kv.version);
      const inRange = v && v[0] < KEYOKU_RANGE.maxExclusive && (v[0] > KEYOKU_RANGE.min[0] || (v[0] === KEYOKU_RANGE.min[0] && v[1] >= KEYOKU_RANGE.min[1]));
      if (inRange) say('ok', `keyoku ${kv.version} (${kv.path}) — inside the pinned range >=2.7 <3`);
      else say('warn', `keyoku ${kv.version} is OUTSIDE the pinned range >=2.7 <3 — the file-layout contract may not hold; re-verify before trusting belay`);
    }
  }

  // ── tokenroom (budget signal) ──
  const tr = tokenroomDir();
  console.log(lines.splice(0).join('\n') + `\n\ntokenroom (${tr})`);
  const st = readJSON(join(tr, 'state.json'));
  if (!existsSync(tr)) say('warn', 'tokenroom not found — budget UNKNOWN (stop decisions permissive, no spawn gating)');
  else if (!st || typeof st.updated_at !== 'number') say('warn', 'state.json missing/unreadable — budget UNKNOWN');
  else {
    const age = Math.round((Date.now() / 1000 - st.updated_at) / 60);
    say(age <= 30 ? 'ok' : 'warn', `state.json ${age}m old — budget ${age <= 30 ? 'FRESH' : 'STALE (>30m → UNKNOWN)'}`);
    if (existsSync(join(tr, 'profiles.json'))) say('ok', 'profiles.json present — alt-profile advice enabled');
  }

  // ── hook registration ──
  const dir = configDir([]);
  console.log(lines.splice(0).join('\n') + `\n\nhooks (${join(dir, 'settings.json')})`);
  const settings = readJSON(join(dir, 'settings.json'));
  for (const event of ['Stop', 'PreToolUse']) {
    const entries = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
    const present = entries.some((m) => (m?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.includes(MARK)));
    say(present ? 'ok' : 'warn', `${event} hook ${present ? 'registered' : 'NOT registered — run `belay install`'}`);
  }

  // ── config ──
  console.log(lines.splice(0).join('\n') + `\n\nconfig (${join(belayDir(), 'config.json')})`);
  const { warnings } = readConfig();
  if (!existsSync(join(belayDir(), 'config.json'))) say('ok', 'no config.json — running on defaults');
  else if (warnings.length) for (const w of warnings) say('warn', w);
  else say('ok', 'config valid');
  console.log(lines.splice(0).join('\n'));
}
