import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { belayDir, tokenroomDir, readJSON, readConfig, ensureDir, atomicWriteJSON, sanitizeText, sanitizeSlug, toEpochSec, projectKeyForCwd, projectMatches } from './util.mjs';
import { keyokuHome, tailObservation, unmetDetail } from './keyoku.mjs';
import { readBudget } from './budget.mjs';
import { readLoops } from './loops.mjs';

// Self-proposed loops: scan state files for loop-worthy signals → persist proposal
// objects → surface (SessionStart / belay_propose). Proposals NEVER act (ADR-11): arming
// happens only via an explicit belay_loop_create call. Design: docs/DESIGN.md §4.
//
// ~/.belay/proposals.json (§3.1):
//   { "proposals": [ { "id": "<sha256-12 of kind+key-fields>",
//       "kind": "resume-ready|unfocused-autonomous|stale-converged|budget-reset|keyoku-ripe|orphaned-loop",
//       "summary": "<sanitized ≤200>", "evidence": { …exact figures + source path },
//       "suggested_create": { …belay_loop_create args }, "created_at": <epoch>,
//       "status": "open|dismissed|armed", "surfaced_count": n } ] }
// Content-hash ids: a persisting signal reproduces the same id, so dismissal sticks until
// the signal itself changes. Prune: dismissed/armed >7d; open rows are re-derived on every
// scan (a vanished signal drops its open proposal; ids are stable, so nothing flaps).
//
// Signals (§4.1, ALL pure file reads — SessionStart-latency safe, <50ms):
//   S1 resume-ready          ~/.tokenroom/resume.json valid + now >= resume_at
//                            (suggested inline goal marked needs_probes:true — belay
//                             never invents machine checks)
//   S2 unfocused-autonomous  goals.json: active + autonomous + not focused
//   S3 stale-converged       converged + lastAssessedAt older than cfg.stale_converged_days
//                            → suggests a DIRECT keyoku goal_assess, NOT a loop
//   S4 budget-reset          state.json five_hour crossed resets_at (<30min ago) or
//                            left_pct >= 85 with a paused loop / S1 open — an AMPLIFIER:
//                            attached to the S1 proposal when one exists, and surfaced as a
//                            resume-the-paused-loop proposal per paused loop (the §3.1
//                            'budget-reset' kind) — it never proposes a NEW loop of its own
//   S5 keyoku-ripe           ~/.keyoku/ripe.json fresh (<24h) suggestions, deduped against
//                            surfaced.json — advisory, sanitized (cross-goal data, ADR-7)
//
// Every summary/slug/suggestion string here is file-controlled input that lands in
// model-visible text (belay_propose results, SessionStart context) → ADR-7 sanitize + cap
// at the point of derivation, and again at the surfacing boundary (session-start.mjs).

const DAY = 86400;
const PRUNE_SEC = 7 * DAY;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const proposalsPath = () => join(belayDir(), 'proposals.json');
const hashId = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);

/** proposals.json rows, defensively: absent/malformed → [] (ADR-4). */
function readProposalsFile() {
  const s = readJSON(proposalsPath());
  if (!s || typeof s !== 'object' || !Array.isArray(s.proposals)) return [];
  return s.proposals.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id);
}

/** S1 — deferred work past its resume time (tokenroom resume.json, readResume rules:
 *  string summary, numeric created_at, <24h old; ready when now >= resume_at). */
function scanResume(now) {
  const source = join(tokenroomDir(), 'resume.json');
  const r = readJSON(source);
  if (!r || typeof r !== 'object') return null;
  const created = num(r.created_at);
  const resumeAt = num(r.resume_at);
  if (typeof r.summary !== 'string' || !r.summary || created == null) return null; // invalid plan
  if (now - created > 24 * 3600) return null; // 24h-old → null (readResume rule)
  if (resumeAt == null || now < resumeAt) return null; // no resume time / not ready yet
  const summary = sanitizeText(r.summary, 200);
  return {
    id: hashId('resume-ready', summary, String(created), String(resumeAt)),
    kind: 'resume-ready',
    summary: sanitizeText(`deferred work is past its resume time: ${summary}`, 200),
    evidence: { summary, est_tokens: num(r.est_tokens), resume_at: resumeAt, source },
    suggested_create: {
      objective: sanitizeText(`finish deferred work: ${summary}`, 200),
      criteria: [{ description: 'PLACEHOLDER — replace with a machine-checkable probe + assertion before creating (belay never invents machine checks)' }],
    },
    needs_probes: true,
  };
}

/** S2 + S3 — one goals.json pass: unfocused active autonomous goals (armable) and
 *  stale-converged goals (re-assess candidates; a DIRECT goal_assess, never a loop).
 *  `sessionProject` (ADR-33, the project key derived from the CALLER's cwd — null when the
 *  caller passed no cwd, e.g. an older caller or one that never wired it through) scopes S2
 *  ONLY: an unfocused-autonomous goal whose loops.json entry carries a `project` that does
 *  NOT match (same key, or this session's project nested inside it — ADR-5-style subtree)
 *  is skipped — the "~60 cross-project proposals" leak. A goal with NO loops.json entry, or
 *  whose entry has no `project` field (never armed via belay, or armed before ADR-33), or a
 *  null `sessionProject` (no cwd known) ALWAYS falls back to today's behavior — surfaced,
 *  never hidden (never hide a legacy loop on unprovable evidence, mirrors ADR-4's "absent
 *  data never denies" posture). S3 (stale-converged, an advisory re-assess suggestion, not a
 *  loop) is deliberately left unscoped — out of scope for this pass. */
function scanGoals(now, cfg, sessionProject = null) {
  const home = keyokuHome();
  const source = join(home, 'goals.json');
  const goals = readJSON(source);
  if (!Array.isArray(goals)) return [];
  const focus = readJSON(join(home, 'focus.json'));
  const focusedId = focus && typeof focus === 'object' && typeof focus.goalId === 'string' ? focus.goalId : null;
  const loopsMap = readLoops().loops;
  const out = [];
  for (const g of goals) {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id) continue;
    const slug = sanitizeSlug(typeof g.slug === 'string' && g.slug ? g.slug : g.id); // model-visible + create ref (ADR-7)
    if (g.status === 'active' && g.autonomy === 'autonomous' && g.id !== focusedId) {
      const loopProject = loopsMap[g.id]?.project;
      if (sessionProject && typeof loopProject === 'string' && loopProject && !projectMatches(sessionProject, loopProject)) continue; // ADR-33: a different project's loop — not this session's business
      const used = num(g.usedIterations);
      const max = num(g.maxIterations);
      const unmet = unmetDetail(g, tailObservation(join(home, 'observations', `${g.id}.jsonl`)));
      out.push({
        id: hashId('unfocused-autonomous', g.id),
        kind: 'unfocused-autonomous',
        summary: sanitizeText(`goal '${slug}' is active + autonomous but unfocused (${used ?? '?'}/${max ?? '?'} iterations used)`, 200),
        evidence: { goalId: sanitizeSlug(g.id), slug, usedIterations: used, maxIterations: max, lastAssessedAt: typeof g.lastAssessedAt === 'string' ? g.lastAssessedAt : null, ...(unmet && unmet.length ? { unmet } : {}), source },
        suggested_create: { goal: slug }, // cwd: the caller supplies
      });
    } else if (g.status === 'converged') {
      const t = toEpochSec(g.lastAssessedAt) ?? toEpochSec(g.convergedAt);
      if (t == null || now - t <= cfg.stale_converged_days * DAY) continue; // strictly older than the edge
      const ageDays = Math.round((now - t) / DAY);
      out.push({
        id: hashId('stale-converged', g.id, String(t)), // a re-assess changes lastAssessedAt → new signal
        kind: 'stale-converged',
        summary: sanitizeText(`goal '${slug}' converged but not re-assessed in ${ageDays}d — run keyoku goal_assess to check for drift (assess is free; a loop only if drift is found)`, 200),
        evidence: { goalId: sanitizeSlug(g.id), slug, convergedAt: typeof g.convergedAt === 'string' ? g.convergedAt : null, lastAssessedAt: typeof g.lastAssessedAt === 'string' ? g.lastAssessedAt : null, age_days: ageDays, source },
        suggested_create: null, // NOT a loop (DESIGN §4.1 S3)
        suggested_action: { tool: 'goal_assess', arguments: { goal: slug } },
      });
    }
  }
  return out;
}

/** ~/.keyoku/surfaced.json → the ids keyoku already nudged about (shape read maximally
 *  defensively: array of ids, {ids:[…]}, or an object keyed by id). */
function surfacedIds(home) {
  const s = readJSON(join(home, 'surfaced.json'));
  const ids = new Set();
  const add = (v) => typeof v === 'string' && v && ids.add(v);
  if (Array.isArray(s)) s.forEach(add);
  else if (s && typeof s === 'object') {
    if (Array.isArray(s.ids)) s.ids.forEach(add);
    else Object.keys(s).forEach(add);
  }
  return ids;
}

/** S5 — keyoku's own ripe suggestions (advisory; cross-goal data → full ADR-7 posture). */
function scanRipe(now) {
  const home = keyokuHome();
  const source = join(home, 'ripe.json');
  const r = readJSON(source);
  if (!r || typeof r !== 'object' || !Array.isArray(r.suggestions) || r.suggestions.length === 0) return [];
  const at = toEpochSec(r.at);
  if (at == null || now - at > 24 * 3600) return []; // stale cache
  const surfaced = surfacedIds(home);
  const out = [];
  for (const s of r.suggestions) {
    const sid = [s?.id, s?.goalId].find((v) => typeof v === 'string' && v) ?? null;
    if (sid && surfaced.has(sid)) continue; // keyoku already surfaced this one
    const raw = typeof s === 'string' ? s : [s?.reason, s?.text, s?.summary, s?.message].find((v) => typeof v === 'string' && v) ?? null;
    const text = sanitizeText(raw ?? (sid ? `goal ${sanitizeSlug(sid)} looks ripe` : ''), 200);
    if (!text) continue; // nothing surfaceable in this entry
    out.push({
      id: hashId('keyoku-ripe', sid ?? '', text),
      kind: 'keyoku-ripe',
      summary: sanitizeText(`keyoku suggests: ${text}`, 200),
      evidence: { ...(sid ? { goalId: sanitizeSlug(sid) } : {}), suggestion: text, at, source },
      suggested_create: null, // advisory — investigate via keyoku's own tools
      suggested_action: sid ? { tool: 'goal_get', arguments: { goal: sanitizeSlug(sid) } } : { tool: 'goal_list', arguments: {} },
    });
  }
  return out;
}

/** S6 — orphaned loop (ADR-21): an armed, session-pinned, non-paused loop whose arming
 *  session is no longer active in tokenroom's sessions.json. When the arming session dies
 *  (crash, or a compaction restart that mints a new session id) the focus stays pinned to a
 *  dead session — every other session gets scope-mismatch silent allows and the loop is
 *  invisible at SessionStart forever (S2 excludes focused goals; S4 only covers paused).
 *  Conservative: if tokenroom's sessions.json is absent we CANNOT tell a session is dead, so
 *  no signal is raised (never a false orphan). */
function scanOrphanedLoops(now) {
  const entries = Object.entries(readLoops().loops);
  if (!entries.length) return [];
  const sessMap = readJSON(join(tokenroomDir(), 'sessions.json'));
  if (!sessMap || typeof sessMap !== 'object' || Array.isArray(sessMap)) return []; // can't prove any session dead
  const ACTIVE_SEC = 30 * 60;
  const isActive = (sid) => {
    const e = sessMap[sid];
    const at = e && typeof e === 'object' ? toEpochSec(e.at) : null;
    return at != null && now - at <= ACTIVE_SEC;
  };
  const focus = readJSON(join(keyokuHome(), 'focus.json'));
  const focusId = focus && typeof focus === 'object' && typeof focus.goalId === 'string' ? focus.goalId : null;
  const source = join(belayDir(), 'loops.json');
  const out = [];
  for (const [goalId, e] of entries) {
    if (!e || typeof e !== 'object' || e.armed !== true || e.paused === true) continue;
    const sid = typeof e.session_id === 'string' && e.session_id ? e.session_id : null;
    if (!sid || isActive(sid)) continue; // global/unpinned loop, or its arming session is alive
    const gid = sanitizeSlug(goalId);
    const focused = goalId === focusId;
    out.push({
      id: hashId('orphaned-loop', goalId, sid),
      kind: 'orphaned-loop',
      summary: sanitizeText(`loop for goal '${gid}' is armed but pinned to session ${sanitizeSlug(sid, 16)} which is no longer active — resume it in THIS session (re-arm with your session_id) or disarm it`, 200),
      evidence: { goalId: gid, pinned_session: sanitizeSlug(sid, 24), focused, source },
      suggested_create: focused ? { goal: gid } : null, // re-arm here when it is still the focused goal
      suggested_action: { tool: 'belay_loop_disarm', arguments: { goal: goalId } },
    });
  }
  return out;
}

/** S4 predicate — is the 5h budget fresh? Either the window just reset (resets_at < now
 *  <= resets_at + 30min: the crossedReset band readBudget treats as UNKNOWN — quota just
 *  refilled), or a known fresh reading with >=85% left. Returns the evidence or null. */
function budgetFresh(now) {
  const source = join(tokenroomDir(), 'state.json');
  const resets = toEpochSec(readJSON(source)?.windows?.five_hour?.resets_at);
  if (resets != null && now > resets && now <= resets + 30 * 60) {
    return { resets_at: resets, left_pct: 'post-reset (full)', source };
  }
  const b = readBudget(undefined, now);
  if (b.known && b.left_pct != null && b.left_pct >= 85) return { resets_at: b.resets_at, left_pct: b.left_pct, source };
  return null;
}

/**
 * Run the S1–S5 scan, merge with (and persist to) proposals.json — dedupe by content-hash
 * id, keep sticky dismissals, prune. Returns the full current proposal list (open first).
 * Read-only over keyoku/tokenroom files; writes only ~/.belay/proposals.json. Never
 * throws on absent/malformed inputs (ADR-4) — a bad source file just yields no signal.
 * Master switch: cfg.proposals_enabled (false → { proposals: [] }, no writes).
 * @param {{ nowSec?: number, cwd?: string }} [opts] injectable clock for tests; `cwd`
 *   (ADR-33, additive/optional) scopes the S2 unfocused-autonomous signal to THIS caller's
 *   project — omitted/non-string → today's unscoped behavior (backward-compat).
 * @returns {{ proposals: object[] }}
 */
export function scan({ nowSec: now = Date.now() / 1000, cwd } = {}) {
  try {
    const { cfg } = readConfig();
    if (!cfg.proposals_enabled) return { proposals: [] };
    const sessionProject = typeof cwd === 'string' && cwd ? projectKeyForCwd(cwd) : null;

    const fresh = [];
    const s1 = scanResume(now);
    if (s1) fresh.push(s1);
    fresh.push(...scanGoals(now, cfg, sessionProject));
    fresh.push(...scanRipe(now));
    fresh.push(...scanOrphanedLoops(now));

    // S4 — amplifier, never standalone: decorate the S1 proposal(s), and surface each
    // PAUSED loop as a resume-it proposal (the only actionable attachment a paused loop has).
    const s4 = budgetFresh(now);
    if (s4) {
      for (const p of fresh) if (p.kind === 'resume-ready') p.amplifier = { kind: 'budget-reset', evidence: s4 };
      for (const [goalId, e] of Object.entries(readLoops().loops)) {
        if (!e || typeof e !== 'object' || e.paused !== true) continue;
        const gid = sanitizeSlug(goalId); // loops.json is belay-written, but sanitize anyway (ADR-7)
        const leftTxt = typeof s4.left_pct === 'number' ? `${Math.round(s4.left_pct)}% left` : s4.left_pct;
        fresh.push({
          id: hashId('budget-reset', goalId, String(s4.resets_at ?? '')),
          kind: 'budget-reset',
          summary: sanitizeText(`budget is fresh (${leftTxt}) and the loop for goal '${gid}' is paused — resume it`, 200),
          evidence: { ...s4, paused_goal: gid },
          suggested_create: null, // amplifier: resumes an EXISTING loop, never proposes a new one
          suggested_action: { tool: 'belay_loop_resume', arguments: { goal: goalId } },
        });
      }
    }

    // Merge: content-hash ids make dismissal durable — a persisting signal reproduces the
    // same id, so a dismissed/armed row wins over its re-derived twin (until the 7d prune,
    // after which a STILL-persisting signal legitimately resurfaces as open).
    const existing = readProposalsFile();
    const byId = new Map(existing.map((p) => [p.id, p]));
    const merged = [];
    const seen = new Set();
    for (const p of fresh) {
      if (seen.has(p.id)) continue; // one signal, one row
      seen.add(p.id);
      const prev = byId.get(p.id);
      const prevFresh = prev && now - (num(prev.created_at) ?? 0) <= PRUNE_SEC;
      if (prevFresh && (prev.status === 'dismissed' || prev.status === 'armed')) {
        merged.push(prev); // sticky — keep the recorded row verbatim
      } else {
        merged.push({ ...p, created_at: prevFresh && prev.status === 'open' ? prev.created_at : Math.round(now), status: 'open', surfaced_count: prevFresh && num(prev.surfaced_count) != null ? prev.surfaced_count : 0 });
      }
    }
    // Keep un-reproduced dismissed/armed history (audit + stickiness) until the 7d prune;
    // un-reproduced OPEN rows simply drop — open truth is re-derived on every scan.
    for (const p of existing) {
      if (seen.has(p.id)) continue;
      if (p.status !== 'dismissed' && p.status !== 'armed') continue;
      if (now - (num(p.created_at) ?? 0) > PRUNE_SEC) continue;
      merged.push(p);
    }

    const proposals = [...merged.filter((p) => p.status === 'open'), ...merged.filter((p) => p.status !== 'open')];
    try {
      if (proposals.length || existing.length) {
        ensureDir(belayDir());
        atomicWriteJSON(proposalsPath(), { proposals });
      }
    } catch {
      // persistence is best-effort — the scan result still stands (ADR-4)
    }
    return { proposals };
  } catch {
    return { proposals: [] }; // ADR-4: never a throw on the surfacing path
  }
}

/**
 * Dismiss one proposal by id (status:'dismissed' in proposals.json). Sticky: the same
 * content-hash id won't re-surface until the underlying signal changes.
 * @param {string} id
 * @returns {object} { ok:true, id } | { ok:false, error }
 */
export function dismiss(id) {
  try {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'dismiss: a proposal id is required' };
    const proposals = readProposalsFile();
    const p = proposals.find((x) => x.id === id);
    if (!p) return { ok: false, error: `dismiss: no proposal with id '${sanitizeSlug(id, 24)}' — run belay_propose to list current ids` };
    if (p.status === 'armed') return { ok: false, error: `dismiss: proposal '${p.id}' was already armed — stand the loop down with belay_loop_disarm instead` };
    p.status = 'dismissed';
    ensureDir(belayDir());
    atomicWriteJSON(proposalsPath(), { proposals });
    return { ok: true, id: p.id };
  } catch (e) {
    return { ok: false, error: sanitizeText(String(e?.message ?? e), 200) };
  }
}
