import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { belayDir, ensureDir, atomicWriteJSON, readJSON, sanitizeText, sanitizeSlug } from './util.mjs';

// Deferred-action queue: ~/.belay/pending.json (ADR-16). Written by the PreToolUse hook
// in gate_mode 'defer' (one entry per denied-and-deferred action) and drained by the
// `belay pending` CLI. PRESENTATION METADATA ONLY: no gate or stop DECISION ever reads
// this file (the ADR-12 no-path rule, mirrored) — the deny already happened; the queue
// only tells the human what to review in one batch at convergence.
//   { pending: [ { id, ts, class, tool_name, command, goalId, sessionId } ] }
// Same hardening as state.mjs: dir 0700, file 0600, atomic tmp+rename, and every write
// re-reads the freshest copy (per-entry last-writer-wins, the L1-1 discipline).

const COMMAND_CAP = 500;
const pendingPath = () => join(belayDir(), 'pending.json');

/** Absent/malformed → { pending: [] } (ADR-4): every consumer degrades to "0 pending". */
export function readPending() {
  const s = readJSON(pendingPath());
  if (s && typeof s === 'object' && Array.isArray(s.pending)) {
    return { pending: s.pending.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && e.id) };
  }
  return { pending: [] };
}

/** Short content hash of class+tool_name+command+goalId: the same deferred action queues
 *  ONCE, no matter how many times the loop retries it. tool_name is IN the hash because
 *  MCP-tool hits share one class and an empty command — without it, two distinct external
 *  sends under the same goal would collide and the second would vanish from the human's
 *  review. JSON-array encoding keeps field boundaries unambiguous (a command containing
 *  newlines can't alias another field split). */
export function pendingId({ class: cls, tool_name, command, goalId }) {
  const field = (v) => (typeof v === 'string' ? v : '');
  return createHash('sha256')
    .update(JSON.stringify([field(cls), field(tool_name), field(command), field(goalId)]))
    .digest('hex')
    .slice(0, 16);
}

/** Append one queue entry (dedupe by content id). Returns the entry id. Callers on the
 *  hook path wrap this in their own try/catch: a failed append must NEVER drop the deny. */
export function appendPending({ class: cls, tool_name, command, goalId, sessionId }, nowSec = Math.round(Date.now() / 1000)) {
  const cappedCommand = (typeof command === 'string' ? command : '').slice(0, COMMAND_CAP);
  const entry = {
    id: pendingId({ class: cls, tool_name, command: cappedCommand, goalId }),
    ts: nowSec,
    class: typeof cls === 'string' && cls ? cls : 'unknown',
    tool_name: typeof tool_name === 'string' ? tool_name : '',
    command: cappedCommand,
    goalId: typeof goalId === 'string' ? goalId : null,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
  };
  const fresh = readPending(); // read-fresh at write time (state.mjs L1-1 discipline)
  if (fresh.pending.some((e) => e.id === entry.id)) return entry.id;
  fresh.pending.push(entry);
  ensureDir(belayDir());
  atomicWriteJSON(pendingPath(), fresh);
  return entry.id;
}

/** { count, classes } for status surfaces — classes deduped and sanitized (ADR-7 posture:
 *  class text can originate from config ask_patterns, a file, so it never lands raw). */
export function pendingSummary() {
  const { pending } = readPending();
  const classes = [...new Set(pending.map((e) => sanitizeText(String(e.class ?? 'unknown'), 40) || 'unknown'))];
  return { count: pending.length, classes };
}

/** Empty the queue. Returns how many entries were cleared. */
export function clearPending() {
  const n = readPending().pending.length;
  ensureDir(belayDir());
  atomicWriteJSON(pendingPath(), { pending: [] });
  return n;
}

/** Remove one entry by id. Returns true when an entry was actually removed. */
export function removePending(id) {
  if (typeof id !== 'string' || !id) return false;
  const fresh = readPending();
  const kept = fresh.pending.filter((e) => e.id !== id);
  if (kept.length === fresh.pending.length) return false;
  ensureDir(belayDir());
  atomicWriteJSON(pendingPath(), { pending: kept });
  return true;
}

/** `belay pending [--clear | --remove <id>]` — the human's batched-review surface.
 *  Commands/classes are file-derived text headed for a terminal, so both are sanitized
 *  (control chars stripped) before printing. */
export function pendingCommand(f = {}) {
  if (f.clear === true) {
    const n = clearPending();
    console.log(`belay pending: cleared ${n} deferred ${n === 1 ? 'entry' : 'entries'}`);
    return;
  }
  if (f.remove !== undefined) {
    const id = typeof f.remove === 'string' ? f.remove : '';
    if (removePending(id)) console.log(`belay pending: removed ${sanitizeSlug(id, 16)}`);
    else {
      console.log(`belay pending: no entry with id '${sanitizeSlug(id, 16)}'`);
      process.exitCode = 2;
    }
    return;
  }
  const { pending } = readPending();
  console.log(`belay pending — ${pending.length} deferred ${pending.length === 1 ? 'action' : 'actions'} awaiting approval (${pendingPath()})`);
  for (const e of pending) {
    const at = typeof e.ts === 'number' && Number.isFinite(e.ts) ? new Date(e.ts * 1000).toISOString() : '?';
    const who = [e.goalId ? `goal ${sanitizeSlug(String(e.goalId), 32)}` : null, e.sessionId ? `session ${sanitizeSlug(String(e.sessionId), 32)}` : null].filter(Boolean).join(' · ');
    console.log(`  ${sanitizeSlug(String(e.id), 16)}  '${sanitizeText(String(e.class ?? 'unknown'), 40)}'  ${e.tool_name ? `[${sanitizeSlug(String(e.tool_name), 48)}] ` : ''}${who ? `(${who}) ` : ''}at ${at}`);
    if (e.command) console.log(`      ${sanitizeText(String(e.command), 500)}`);
  }
  if (pending.length) console.log(`  review each, run the approved ones yourself, then \`belay pending --clear\` (or --remove <id>)`);
}
