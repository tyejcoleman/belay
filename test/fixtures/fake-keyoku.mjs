#!/usr/bin/env node
// fake-keyoku — the ROUND-0 FROZEN fixture server every fill agent tests against
// (docs/DESIGN.md §6.0.2). A stdio newline-JSON-RPC responder that implements
// initialize / tools/list / tools/call for goal_create, goal_update, goal_focus,
// goal_unfocus by mutating $KEYOKU_HOME files the way real keyoku does: atomic
// tmp+rename, same row/focus shapes (types.ts:156-171, mapped 2026-07-01), cacheless
// read-modify-write. Responses put JSON in result.content[0].text like the MCP SDK.
// T4 refute diff-checks these shapes against keyoku's store.ts (fixture-drift risk, §9).

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const HOME = process.env.KEYOKU_HOME;
if (!HOME) {
  process.stderr.write('fake-keyoku: KEYOKU_HOME not set\n');
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

const TOOL_NAMES = ['goal_create', 'goal_update', 'goal_focus', 'goal_unfocus'];

function toolCall(name, a = {}) {
  const goals = readGoals();
  if (name === 'goal_create') {
    if (typeof a.objective !== 'string' || !a.objective || !Array.isArray(a.criteria) || a.criteria.length === 0)
      return { error: 'goal_create: objective and criteria[] are required' }; // zod-ish refusal
    const row = {
      id: `goal_${randomBytes(6).toString('hex')}`,
      slug: a.slug || a.objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48),
      objective: a.objective,
      criteria: a.criteria.map((c, i) => ({ id: c?.id || `c${i + 1}`, ...c })),
      constraints: Array.isArray(a.constraints) ? a.constraints : [],
      autonomy: typeof a.autonomy === 'string' ? a.autonomy : 'suggest',
      maxIterations: typeof a.maxIterations === 'number' ? a.maxIterations : 50,
      usedIterations: 0,
      status: 'active',
      createdAt: iso(),
      updatedAt: iso(),
    };
    atomicWrite(goalsPath, [...goals, row]); // whole-array write, like real keyoku
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
  return null; // unknown tool → -32602 at the rpc layer
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // garbage line — ignore, keep serving
  }
  if (!req || typeof req !== 'object' || req.id === undefined) return; // notification
  try {
    if (req.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
          serverInfo: { name: 'keyoku-fake', version: '2.12.0' },
          capabilities: { tools: {} },
        },
      });
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
}); // exits when stdin ends, like real keyoku serve()
