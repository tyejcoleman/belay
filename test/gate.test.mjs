import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeTokenroom, writeProfiles, writeLoops, toolPayload, nowSec } from './helpers.mjs';

// T1: PreToolUse gate — active ONLY under a scope-matched focused AUTONOMOUS goal.

const gate = (h, payload) => run(h, ['hook', 'pre-tool-use'], payload);

function armed() {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
  return h;
}

// B6/ADR-28: an armed goal whose loops.json entry ALSO declares an autonomy level, owned by
// the same session ('s1') toolPayload() defaults to — so B3's session-owned resolution picks
// it up and src/gate.mjs's loopAutonomy(k.goal.id) sees the declared level.
function armedWithAutonomy(level) {
  const h = armed();
  writeLoops(h, { goal_test1: { session_id: 's1', ...(level !== undefined ? { autonomy: level } : {}) } });
  return h;
}

const askOf = (r) => {
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'ask');
  return o.permissionDecisionReason;
};

test('git push under an autonomous goal → ask with the policy wording', () => {
  const reason = askOf(gate(armed(), toolPayload({ tool_input: { command: 'git push origin main' } })));
  assert.equal(reason, "[belay] 'git push' action under autonomous goal — requires human approval (goal constraint policy)");
});

test('bypassPermissions escalates ask → deny (the harness cannot render an ask there)', () => {
  const h = armed();
  const r = gate(h, toolPayload({ permission_mode: 'bypassPermissions', tool_input: { command: 'git push origin main' } }));
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /'git push'/);
  assert.match(o.permissionDecisionReason, /bypassPermissions/);
  // ADR-19: the deny must NOT advertise disarm-then-retry (that launders the arrest); it
  // sends the human to a non-bypass session instead.
  assert.match(o.permissionDecisionReason, /WITHOUT bypassPermissions/);
  assert.doesNotMatch(o.permissionDecisionReason, /belay_loop_pause/);
  // ungated commands stay silent even in bypass mode — no over-denying
  assert.equal(gate(h, toolPayload({ permission_mode: 'bypassPermissions', tool_input: { command: 'git commit -m wip' } })).stdout, '');
  // every other mode keeps the plain ask
  const ask = JSON.parse(gate(h, toolPayload({ permission_mode: 'acceptEdits', tool_input: { command: 'git push' } })).stdout);
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
});

test('doctor warns when permissions.defaultMode is bypassPermissions (ADR-13)', () => {
  const h = homes();
  mkdirSync(h.config, { recursive: true });
  writeFileSync(join(h.config, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  const r = run(h, ['doctor']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /defaultMode is bypassPermissions/);
  assert.match(r.stdout, /ADR-13/);

  const h2 = homes();
  mkdirSync(h2.config, { recursive: true });
  writeFileSync(join(h2.config, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
  assert.doesNotMatch(run(h2, ['doctor']).stdout, /bypassPermissions/);
});

test('npm publish and gh pr merge → ask; plain git commit / gh pr view → silent', () => {
  const h = armed();
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'npm publish --access public' } }))), /'npm publish'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'gh pr merge 42 --squash' } }))), /'gh mutation'/);
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git commit -m "wip"' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'gh pr view 42' } })).stdout, '');
});

test('rm -rf: outside cwd → ask; inside cwd → silent', () => {
  const h = armed();
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'rm -rf /etc/nginx' } }))), /'rm -rf outside cwd'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'rm -rf ~/backups' } }))), /'rm -rf outside cwd'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'rm -rf ../sibling' } }))), /'rm -rf outside cwd'/);
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'rm -rf ./build node_modules' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'rm -rf /tmp/proj/dist' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'rm -r docs' } })).stdout, ''); // recursive but not force
});

test('git/gh global options can no longer smuggle the subcommand past the gate (finding 5)', () => {
  const h = armed();
  // global options between the binary and the subcommand — the old regex missed these
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git -C /repo push origin main' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git --git-dir=/x/.git push' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git -c user.name=x push' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'gh -R owner/repo pr merge 42' } }))), /'gh mutation'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'env FOO=bar git push' } }))), /'git push'/);
  // non-mutating subcommands with global options stay silent (no over-asking)
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git -C /repo status' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'gh -R owner/repo pr view 42' } })).stdout, '');
});

test('rm -rf hidden behind a shell wrapper is still caught (finding 4)', () => {
  const h = armed(); // cwd defaults to /tmp/proj
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: "sh -c 'rm -rf /etc/nginx'" } }))), /'rm -rf outside cwd'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'env FOO=bar rm -rf /etc' } }))), /'rm -rf outside cwd'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'rm -rf $(cat targets)' } }))), /'rm -rf outside cwd'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'cat list | xargs rm -rf' } }))), /'rm -rf outside cwd'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: '/bin/rm -rf ~/data' } }))), /'rm -rf outside cwd'/);
  // an inside-cwd delete through a wrapper still passes silently (no over-asking)
  assert.equal(gate(h, toolPayload({ tool_input: { command: "sh -c 'rm -rf ./build'" } })).stdout, '');
});

test('curl/wget writes: non-localhost POST/PUT → ask; localhost or GET → silent', () => {
  const h = armed();
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'curl -X POST https://api.example.com/v1/launch -d @payload.json' } }))), /'network write'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'wget --method=PUT --body-data=x https://example.com/upload' } }))), /'network write'/);
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'curl -X POST http://localhost:3000/api/test -d "{}"' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'curl -X POST http://127.0.0.1:8080/hook -d x' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'curl -s https://example.com/data.json' } })).stdout, '');
});

test('mcp send/publish tool names → ask; built-in SendMessage stays untouched', () => {
  const h = armed();
  assert.match(askOf(gate(h, toolPayload({ tool_name: 'mcp__slack__conversations_add_message', tool_input: { channel: 'C1', text: 'hi' } }))), /'external send\/publish'/);
  assert.match(askOf(gate(h, toolPayload({ tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: {} }))), /'external send\/publish'/);
  assert.equal(gate(h, toolPayload({ tool_name: 'SendMessage', tool_input: {} })).stdout, ''); // in-session coordination, not external
  assert.equal(gate(h, toolPayload({ tool_name: 'mcp__slack__conversations_history', tool_input: {} })).stdout, '');
});

test('spawn gate: Task/Agent/Workflow under thin budget → ask; healthy, alt-profile, or no tokenroom → silent', () => {
  const thin = armed();
  writeTokenroom(thin, { leftPct: 8 });
  const reason = askOf(gate(thin, toolPayload({ tool_name: 'Task', tool_input: { prompt: 'go' } })));
  assert.equal(reason, '[belay] budget descent: no new subagents below 10% — do the work inline in small steps');

  const healthy = armed();
  writeTokenroom(healthy, { leftPct: 60 });
  assert.equal(gate(healthy, toolPayload({ tool_name: 'Agent', tool_input: {} })).stdout, '');

  // conservative on stale data: a stale LOW last-known reading still gates
  const staleLow = armed();
  writeTokenroom(staleLow, { leftPct: 8, updatedAgoSec: 45 * 60 });
  assert.match(askOf(gate(staleLow, toolPayload({ tool_name: 'Workflow', tool_input: {} }))), /budget descent/);

  // fresh alt profile lifts the spawn gate (capacity exists, just elsewhere)
  const alt = armed();
  writeTokenroom(alt, { leftPct: 8 });
  writeProfiles(alt, { work: { left_pct: 80, updated_at: nowSec() - 60 } });
  assert.equal(gate(alt, toolPayload({ tool_name: 'Task', tool_input: {} })).stdout, '');

  // tokenroom never installed → budget was never measured → no spawn gating
  const none = armed();
  assert.equal(gate(none, toolPayload({ tool_name: 'Task', tool_input: {} })).stdout, '');
});

test('gate is inert without an autonomous focus: no focus, observe goal, scope mismatch, paused', () => {
  const cmd = { command: 'git push origin main' };

  const noFocus = homes();
  writeKeyoku(noFocus, { goals: [goal()] });
  assert.equal(gate(noFocus, toolPayload({ tool_input: cmd })).stdout, '');

  const observe = homes();
  writeKeyoku(observe, { goals: [goal({ autonomy: 'observe' })], focus: focusFor(), obsLines: [obs()] });
  assert.equal(gate(observe, toolPayload({ tool_input: cmd })).stdout, '');

  const elsewhere = armed();
  assert.equal(gate(elsewhere, toolPayload({ cwd: '/somewhere/else', tool_input: cmd })).stdout, '');

  const paused = homes();
  writeKeyoku(paused, { goals: [goal()], focus: focusFor(), obsLines: [obs()], paused: true });
  assert.equal(gate(paused, toolPayload({ tool_input: cmd })).stdout, '');
});

test('gate_enabled:false disables the gate; allow_overrides force-allow; ask_patterns extend it', () => {
  const off = armed();
  mkdirSync(off.belay, { recursive: true });
  writeFileSync(join(off.belay, 'config.json'), JSON.stringify({ gate_enabled: false }));
  assert.equal(gate(off, toolPayload({ tool_input: { command: 'git push' } })).stdout, '');

  const overridden = armed();
  mkdirSync(overridden.belay, { recursive: true });
  writeFileSync(join(overridden.belay, 'config.json'), JSON.stringify({ allow_overrides: ['git push origin preview'] }));
  assert.equal(gate(overridden, toolPayload({ tool_input: { command: 'git push origin preview' } })).stdout, '');
  assert.match(askOf(gate(overridden, toolPayload({ tool_input: { command: 'git push origin main' } }))), /'git push'/);

  const extended = armed();
  mkdirSync(extended.belay, { recursive: true });
  writeFileSync(join(extended.belay, 'config.json'), JSON.stringify({ ask_patterns: [{ pattern: 'terraform\\s+apply', class: 'infra apply', note: 'production infra' }] }));
  const reason = askOf(gate(extended, toolPayload({ tool_input: { command: 'terraform apply -auto-approve' } })));
  assert.equal(reason, "[belay] 'infra apply' action under autonomous goal — requires human approval (goal constraint policy) — production infra");
});

// ── gate_mode 'defer' (ADR-16): deny-with-guidance + pending queue ─────────────────────

function deferred() {
  const h = armed();
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'config.json'), JSON.stringify({ gate_mode: 'defer' }));
  return h;
}

const denyOf = (r) => {
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'deny');
  return o.permissionDecisionReason;
};

const readQueue = (h) => JSON.parse(readFileSync(join(h.belay, 'pending.json'), 'utf8'));

test('gate_mode defer: every irreversible class → deny-with-guidance, queued in pending.json', () => {
  const cases = [
    [{ tool_input: { command: 'git push origin main' } }, 'git push'],
    [{ tool_input: { command: 'npm publish --access public' } }, 'npm publish'],
    [{ tool_input: { command: 'gh pr merge 42 --squash' } }, 'gh mutation'],
    [{ tool_input: { command: 'rm -rf /etc/nginx' } }, 'rm -rf outside cwd'],
    [{ tool_input: { command: 'curl -X POST https://api.example.com/v1/launch -d @payload.json' } }, 'network write'],
    [{ tool_name: 'mcp__slack__conversations_add_message', tool_input: { channel: 'C1', text: 'hi' } }, 'external send/publish'],
  ];
  for (const [over, cls] of cases) {
    const h = deferred();
    const reason = denyOf(gate(h, toolPayload(over)));
    assert.equal(reason, `[belay] '${cls}' action deferred under autonomous goal — queued for batched human approval at convergence; continue with sandbox-safe work (gate_mode: defer)`);
    const q = readQueue(h);
    assert.equal(q.pending.length, 1, `one queue entry for class '${cls}'`);
    assert.equal(q.pending[0].class, cls);
    assert.equal(q.pending[0].goalId, 'goal_test1'); // from the keyoku read
    assert.equal(q.pending[0].sessionId, 's1'); // from the hook payload
  }
});

test('gate_mode defer: stdout contract shape unchanged — the internal .defer field never leaks', () => {
  const h = deferred();
  const out = JSON.parse(gate(h, toolPayload({ tool_input: { command: 'git push origin main' } })).stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
});

test('ask mode stays byte-identical: no config vs explicit gate_mode:ask, same inputs', () => {
  const payload = toolPayload({ tool_input: { command: 'git push origin main' } });
  const noConfig = gate(armed(), payload);
  const explicit = armed();
  mkdirSync(explicit.belay, { recursive: true });
  writeFileSync(join(explicit.belay, 'config.json'), JSON.stringify({ gate_mode: 'ask' }));
  assert.equal(gate(explicit, payload).stdout, noConfig.stdout);
  assert.equal(JSON.parse(noConfig.stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(
    JSON.parse(noConfig.stdout).hookSpecificOutput.permissionDecisionReason,
    "[belay] 'git push' action under autonomous goal — requires human approval (goal constraint policy)"
  );
});

test('invalid gate_mode falls back to ask with a doctor warning', () => {
  const h = armed();
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'config.json'), JSON.stringify({ gate_mode: 'yolo' }));
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push origin main' } }))), /'git push'/);
  assert.match(run(h, ['doctor']).stdout, /gate_mode must be 'ask' or 'defer'/);
});

test('defer mode: the spawn thin-budget branch stays ask (budget question, not irreversibility)', () => {
  const h = deferred();
  writeTokenroom(h, { leftPct: 8 });
  assert.match(askOf(gate(h, toolPayload({ tool_name: 'Task', tool_input: { prompt: 'go' } }))), /budget descent/);
  // ungated commands stay silent in defer mode too — no over-denying
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git commit -m wip' } })).stdout, '');
});

test('defer mode under bypassPermissions: already deny — ADR-13 semantics preserved', () => {
  const h = deferred();
  const reason = denyOf(gate(h, toolPayload({ permission_mode: 'bypassPermissions', tool_input: { command: 'git push origin main' } })));
  assert.match(reason, /deferred under autonomous goal/);
  assert.match(reason, /queued for batched human approval/);
  assert.equal(readQueue(h).pending.length, 1);
});

// ── B6/ADR-28: loop-autonomy outward-action allowlist ───────────────────────────────────

test('L2 loop: a plain git push is PERMITTED (silent allow) — including to main; force push and npm publish STILL gated', () => {
  const h = armedWithAutonomy('L2');
  // the exact deliverable case: a plain `git push origin <branch>` at L2 → true silent allow
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git push origin feature-x' } })).stdout, '');
  // L2 additionally covers main/master (unlike L1)
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git push origin main' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git push' } })).stdout, ''); // bare push, ambiguous target — fine at L2
  // the always-gated set is NEVER permitted, even at L2
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push --force origin main' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push -f origin feature-x' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push --force-with-lease origin main' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'npm publish --access public' } }))), /'npm publish'/);
});

test('L0 (no autonomy field) loop: git push is STILL deferred/asked — byte-identical to today, no regression', () => {
  const withoutLoopsEntry = armed(); // pre-existing behavior: no loops.json entry at all
  const explicitL0 = armedWithAutonomy('L0'); // explicit L0 must behave identically
  const payload = toolPayload({ tool_input: { command: 'git push origin feature-x' } });
  const r1 = gate(withoutLoopsEntry, payload);
  const r2 = gate(explicitL0, payload);
  assert.equal(r1.stdout, r2.stdout); // byte-identical between the two L0-equivalent worlds
  assert.match(askOf(gate(withoutLoopsEntry, payload)), /'git push'/);
  assert.equal(
    askOf(gate(withoutLoopsEntry, payload)),
    "[belay] 'git push' action under autonomous goal — requires human approval (goal constraint policy)"
  );
});

test('L1 loop: push to a non-default branch permitted; push to main/master, or an unprovable target, stays gated (fail-safe)', () => {
  const h = armedWithAutonomy('L1');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git push origin feature-x' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git push -d origin old-branch' } })).stdout, '');
  // provably targets main/master → stays gated even at L1
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push origin main' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push origin HEAD:master' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push origin --delete main' } }))), /'git push'/);
  // no explicit branch given (bare push, or just a remote) — cannot prove it isn't main → stays gated at L1
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push origin' } }))), /'git push'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push --all origin' } }))), /'git push'/);
  // force is never permitted at L1 either
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push -f origin feature-x' } }))), /'git push'/);
});

test('fail-safe classification: an unparseable/ambiguous or mixed-mutation command STAYS staged even at L2', () => {
  const h = armedWithAutonomy('L2');
  // a chained line where ONE segment targets main taints the whole line (still fine — L2 covers main too, so this specific one stays permitted; force is the real fail-safe probe)
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git push origin feature-x && git push origin main' } })).stdout, '');
  // but a chained line where any segment is a genuine force push stays gated as a whole
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'git push origin feature-x && git push -f origin other' } }))), /'git push'/);
  // gh: a PURE pr write is permitted, but gh release / gh repo / gh api writes are NEVER on the allowlist, even at L2
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'gh pr merge 42 --squash' } })).stdout, '');
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'gh pr create --title x --body y' } })).stdout, '');
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'gh release create v1' } }))), /'gh mutation'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'gh repo delete owner/repo --yes' } }))), /'gh mutation'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'gh api -X POST /repos/o/r/issues' } }))), /'gh mutation'/);
  // a PR write CHAINED with a release write stays gated as a whole (fail-safe: one disqualifying mutation taints the line)
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'gh pr merge 42 && gh release create v1' } }))), /'gh mutation'/);
  // everything outside the allowlist is untouched by autonomy at ANY level — proves the
  // always-gated invariant holds by construction, not by an exclusion list
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'rm -rf /etc/nginx' } }))), /'rm -rf outside cwd'/);
  assert.match(askOf(gate(h, toolPayload({ tool_input: { command: 'curl -X POST https://api.example.com/v1/launch -d @payload.json' } }))), /'network write'/);
  assert.match(askOf(gate(h, toolPayload({ tool_name: 'mcp__slack__conversations_add_message', tool_input: { channel: 'C1', text: 'hi' } }))), /'external send\/publish'/);
});

test('gate_mode defer + L2: a permitted git push is a true silent allow (never queued); force push / npm publish still queued', () => {
  const h = armedWithAutonomy('L2');
  mkdirSync(h.belay, { recursive: true });
  writeFileSync(join(h.belay, 'config.json'), JSON.stringify({ gate_mode: 'defer' }));
  assert.equal(gate(h, toolPayload({ tool_input: { command: 'git push origin main' } })).stdout, '');
  assert.equal(existsSync(join(h.belay, 'pending.json')), false); // nothing queued for the permitted push

  const reason = denyOf(gate(h, toolPayload({ tool_input: { command: 'git push --force origin main' } })));
  assert.match(reason, /deferred under autonomous goal/);
  assert.equal(readQueue(h).pending.length, 1);
  assert.equal(readQueue(h).pending[0].class, 'git push');
});

test('corrupted keyoku files or non-JSON stdin → silent allow, exit 0', () => {
  const bad = homes();
  writeKeyoku(bad, { goals: '][', focus: focusFor() });
  const r1 = gate(bad, toolPayload({ tool_input: { command: 'git push' } }));
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, '');

  const r2 = run(armed(), ['hook', 'pre-tool-use'], 'garbage stdin');
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, '');
});
