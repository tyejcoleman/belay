import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homes, run, goal, focusFor, obs, writeKeyoku, writeTokenroom, writeProfiles, toolPayload, nowSec } from './helpers.mjs';

// T1: PreToolUse gate — active ONLY under a scope-matched focused AUTONOMOUS goal.

const gate = (h, payload) => run(h, ['hook', 'pre-tool-use'], payload);

function armed() {
  const h = homes();
  writeKeyoku(h, { goals: [goal()], focus: focusFor(), obsLines: [obs()] });
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
  assert.equal(reason, "[conductor] 'git push' action under autonomous goal — requires human approval (goal constraint policy)");
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
  assert.equal(reason, '[conductor] budget descent: no new subagents below 10% — do the work inline in small steps');

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
  mkdirSync(off.conductor, { recursive: true });
  writeFileSync(join(off.conductor, 'config.json'), JSON.stringify({ gate_enabled: false }));
  assert.equal(gate(off, toolPayload({ tool_input: { command: 'git push' } })).stdout, '');

  const overridden = armed();
  mkdirSync(overridden.conductor, { recursive: true });
  writeFileSync(join(overridden.conductor, 'config.json'), JSON.stringify({ allow_overrides: ['git push origin preview'] }));
  assert.equal(gate(overridden, toolPayload({ tool_input: { command: 'git push origin preview' } })).stdout, '');
  assert.match(askOf(gate(overridden, toolPayload({ tool_input: { command: 'git push origin main' } }))), /'git push'/);

  const extended = armed();
  mkdirSync(extended.conductor, { recursive: true });
  writeFileSync(join(extended.conductor, 'config.json'), JSON.stringify({ ask_patterns: [{ pattern: 'terraform\\s+apply', class: 'infra apply', note: 'production infra' }] }));
  const reason = askOf(gate(extended, toolPayload({ tool_input: { command: 'terraform apply -auto-approve' } })));
  assert.equal(reason, "[conductor] 'infra apply' action under autonomous goal — requires human approval (goal constraint policy) — production infra");
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
