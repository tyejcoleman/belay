import { join } from 'node:path';
import { readJSON, clampPct, toEpochSec, tokenroomDir } from './util.mjs';

// Tokenroom read contract: $TOKENROOM_DIR || ~/.tokenroom
//   state.json                       ResourceState v0 (top-level / legacy layout)
//   accounts/<key>/state.json        per-account subtree (ADR-21 over there)
//   sessions.json                    session_id → {key, at} map the tap maintains
//   profiles.json                    (R3.5, being built in parallel) named profiles with
//                                    last-known quota — shape read maximally defensively
// Absent or stale (>30min) → budget UNKNOWN: permissive for stop decisions (block without
// a budget line), conservative for spawn gating (a stale LOW last-known still gates —
// we don't assume the window refilled; a tokenroom that was never installed gates nothing).

const STALE_SEC = 30 * 60;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The session's own account dir when the map knows it, else the legacy top-level dir. */
function stateDirFor(root, sessionId, nowSec) {
  const map = readJSON(join(root, 'sessions.json'));
  const e = map && typeof map === 'object' && sessionId ? map[sessionId] : null;
  if (e && typeof e === 'object' && typeof e.key === 'string' && e.key && nowSec - (num(e.at) ?? 0) <= STALE_SEC) {
    const dir = join(root, 'accounts', e.key);
    if (readJSON(join(dir, 'state.json'))) return { dir, key: e.key };
  }
  return { dir: root, key: null };
}

function normalizeProfile(label, e) {
  if (!e || typeof e !== 'object') return null;
  let left = clampPct(e.left_pct);
  if (left == null) {
    const used = clampPct(e.used_pct) ?? clampPct(e.five_hour?.used_pct) ?? clampPct(e.windows?.five_hour?.used_pct);
    if (used != null) left = 100 - used;
  }
  const at = toEpochSec(e.updated_at ?? e.at ?? e.seen_at);
  const name = [e.label, e.name, label].find((v) => typeof v === 'string' && v);
  if (!name || left == null || at == null) return null;
  const key = typeof e.key === 'string' && e.key ? e.key : typeof e.account === 'string' && e.account ? e.account : null;
  return { label: name, left_pct: left, at, key };
}

/**
 * A "known-fresh second profile": from profiles.json, fresh (<30min), not this session's
 * account, and materially better than what we have (≥20% left AND >10 points above our
 * own reading when we have one) — a 4%-left alt is not worth suggesting a switch for.
 */
function pickAltProfile(root, currentKey, currentLeft, nowSec) {
  const raw = readJSON(join(root, 'profiles.json'));
  if (!raw) return null;
  const entries = [];
  if (Array.isArray(raw)) for (const e of raw) entries.push(normalizeProfile(null, e));
  else if (typeof raw === 'object' && Array.isArray(raw.profiles)) for (const e of raw.profiles) entries.push(normalizeProfile(null, e));
  else if (typeof raw === 'object') for (const [k, v] of Object.entries(raw)) entries.push(normalizeProfile(k, v));
  let best = null;
  for (const p of entries) {
    if (!p) continue;
    if (nowSec - p.at > STALE_SEC) continue; // known-fresh only
    if (currentKey && p.key && p.key === currentKey) continue; // that's us, not an alternative
    if (p.left_pct < 20) continue;
    if (currentLeft != null && p.left_pct <= currentLeft + 10) continue;
    if (!best || p.left_pct > best.left_pct) best = p;
  }
  return best ? { label: best.label, left_pct: best.left_pct } : null;
}

/**
 * Budget snapshot for one session:
 *   known           fresh, attributable 5h-window figures exist
 *   left_pct        % left when known
 *   resets_at       epoch sec when known
 *   est_tokens_left tokenroom's heuristic (≈), when present
 *   stale           state exists but is >30min old (or written before a passed reset)
 *   last_known_left the stale reading, for conservative spawn gating only
 *   alt             {label, left_pct} — a known-fresh better profile, or null
 */
export function readBudget(sessionId, nowSec = Date.now() / 1000) {
  const root = tokenroomDir();
  const out = { known: false, left_pct: null, resets_at: null, est_tokens_left: null, stale: false, last_known_left: null, alt: null };
  const { dir, key } = stateDirFor(root, sessionId, nowSec);
  const s = readJSON(join(dir, 'state.json'));
  if (s && typeof s === 'object') {
    const updated = num(s.updated_at);
    const used = clampPct(s.windows?.five_hour?.used_pct);
    const resets = toEpochSec(s.windows?.five_hour?.resets_at);
    // resets_at in the past = the window reset AFTER this was written: the figures are
    // wrong-signed, not merely old (tokenroom's crossedReset lesson) → UNKNOWN, and the
    // stale reading is NOT kept (post-reset quota is effectively full, don't gate on it).
    const crossed = resets != null && nowSec >= resets;
    if (used != null && updated != null && !crossed) {
      if (nowSec - updated <= STALE_SEC) {
        out.known = true;
        out.left_pct = 100 - used;
        out.resets_at = resets;
        out.est_tokens_left = num(s.burn?.est_tokens_left);
      } else {
        out.stale = true;
        out.last_known_left = 100 - used;
      }
    }
  }
  out.alt = pickAltProfile(root, key, out.known ? out.left_pct : out.last_known_left, nowSec);
  return out;
}
