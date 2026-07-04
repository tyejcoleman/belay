#!/usr/bin/env node
// probe-keyoku — a keyoku double that ACTUALLY RUNS each criterion's command probe so
// convergence flips on a REAL exit code, not a hand-appended observation line (closes the
// test-review realism gap). Implements goal_create/update/focus/unfocus like fake-keyoku, PLUS
// goal_assess: run every probe, evaluate its assertion, append an observation with unmet[], and
// converge the goal when nothing is unmet. Same file shapes + atomic writes as real keyoku.

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const HOME = process.env.KEYOKU_HOME;
if (!HOME) {
  process.stderr.write('probe-keyoku: KEYOKU_HOME not set\n');
  process.exit(1);
}
const goalsPath = join(HOME, 'goals.json');
const focusPath = join(HOME, 'focus.json');
const iso = () => new Date().toISOString();

function atomicWrite(path, obj) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
const readGoals = () => {
  try {
    const g = JSON.parse(readFileSync(goalsPath, 'utf8'));
    return Array.isArray(g) ? g : [];
  } catch {
    return [];
  }
};
const findGoal = (goals, ref) => goals.find((g) => g && (g.id === ref || g.slug === ref));

/** Run a command probe; capture stdout even on non-zero exit (assertions read output). */
function runProbe(probe) {
  if (!probe || probe.kind !== 'command' || typeof probe.command !== 'string') return '';
  try {
    return execSync(probe.command, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return typeof e.stdout === 'string' ? e.stdout : '';
  }
}

function evalAssert(output, assert) {
  const a = assert || {};
  const s = String(output ?? '');
  switch (a.op) {
    case 'contains':
      return s.includes(String(a.value ?? ''));
    case 'not_contains':
      return !s.includes(String(a.value ?? ''));
    case 'eq':
      return s.trim() === String(a.value ?? '');
    case 'truthy':
      return s.trim().length > 0;
    default:
      return s.includes(String(a.value ?? '')); // default: contains
  }
}

const TOOL_NAMES = ['goal_create', 'goal_update', 'goal_focus', 'goal_unfocus', 'goal_assess', 'knowledge_submit'];

function toolCall(name, a = {}) {
  const goals = readGoals();
  if (name === 'goal_create') {
    if (typeof a.objective !== 'string' || !a.objective || !Array.isArray(a.criteria) || a.criteria.length === 0) return { error: 'goal_create: objective and criteria[] are required' };
    const row = {
      id: `goal_${randomBytes(6).toString('hex')}`,
      slug: a.slug || a.objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48),
      objective: a.objective,
      criteria: a.criteria.map((c, i) => ({ id: c?.id || `c${i + 1}`, ...c })), // keeps probe + assert
      constraints: Array.isArray(a.constraints) ? a.constraints : [],
      autonomy: typeof a.autonomy === 'string' ? a.autonomy : 'suggest',
      maxIterations: typeof a.maxIterations === 'number' ? a.maxIterations : 50,
      usedIterations: 0,
      status: 'active',
      createdAt: iso(),
      updatedAt: iso(),
    };
    atomicWrite(goalsPath, [...goals, row]);
    return { goal: row };
  }
  if (name === 'goal_update') {
    const g = findGoal(goals, a.goal);
    if (!g) return { error: `goal_update: goal not found: ${a.goal}` };
    for (const k of ['autonomy', 'status', 'maxIterations', 'objective']) if (a[k] !== undefined) g[k] = a[k];
    g.updatedAt = iso();
    atomicWrite(goalsPath, goals);
    return { goal: g };
  }
  if (name === 'goal_focus') {
    const g = findGoal(goals, a.goal);
    if (!g) return { error: `goal_focus: goal not found: ${a.goal}` };
    const focus = { goalId: g.id, goalSlug: g.slug, at: iso() };
    if (typeof a.cwd === 'string' && a.cwd) focus.cwd = a.cwd;
    if (typeof a.sessionId === 'string' && a.sessionId) focus.sessionId = a.sessionId;
    atomicWrite(focusPath, focus);
    return { focus };
  }
  if (name === 'goal_unfocus') {
    if (existsSync(focusPath)) unlinkSync(focusPath);
    return { focus: null };
  }
  if (name === 'knowledge_submit') {
    if (typeof a.subject !== 'string' || !a.subject || typeof a.fact !== 'string' || !a.fact) return { error: 'knowledge_submit: subject and fact are required' };
    appendFileSync(join(HOME, 'knowledge.jsonl'), JSON.stringify({ subject: a.subject, kind: a.kind, fact: a.fact, source: a.source, at: iso() }) + '\n');
    return { ok: true, stored: true, subject: a.subject };
  }
  if (name === 'goal_assess') {
    const g = findGoal(goals, a.goal);
    if (!g) return { error: `goal_assess: goal not found: ${a.goal}` };
    const unmet = [];
    for (const c of Array.isArray(g.criteria) ? g.criteria : []) {
      if (!evalAssert(runProbe(c.probe), c.assert)) unmet.push(c.id);
    }
    g.usedIterations = (typeof g.usedIterations === 'number' ? g.usedIterations : 0) + 1;
    g.lastAssessedAt = iso();
    if (unmet.length === 0) {
      g.status = 'converged';
      g.convergedAt = iso();
    }
    g.updatedAt = iso();
    atomicWrite(goalsPath, goals); // lastAssessedAt persisted BEFORE the obs append, like real keyoku
    mkdirSync(join(HOME, 'observations'), { recursive: true });
    appendFileSync(join(HOME, 'observations', `${g.id}.jsonl`), JSON.stringify({ goalId: g.id, kind: 'assessment', unmet, summary: `${unmet.length} unmet`, at: iso() }) + '\n');
    return { goal: g, unmet, converged: unmet.length === 0 };
  }
  return null;
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (!req || typeof req !== 'object' || req.id === undefined) return;
  try {
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', serverInfo: { name: 'keyoku-probe', version: '2.18.0' }, capabilities: { tools: {} } } });
    } else if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOL_NAMES.map((n) => ({ name: n, inputSchema: { type: 'object' } })) } });
    } else if (req.method === 'tools/call') {
      const out = toolCall(req.params?.name, req.params?.arguments ?? {});
      if (out === null) send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `Unknown tool: ${req.params?.name}` } });
      else send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], ...(out.error ? { isError: true } : {}) } });
    } else {
      send({ jsonrpc: '2.0', id: req.id, result: {} });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});
