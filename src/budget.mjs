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

// tokenroom's REAL profiles.json (src/accounts.mjs writeProfiles/updateProfileSnapshot,
// verified 2026-07-01): { profiles: { <label>: { keys:[...], last_seen, config_dir?,
//   last_windows_snapshot: { at, five_hour:{used_pct, resets_at}, seven_day:{...} } } } }.
// Older/defensive shapes (flat map, array, {profiles:[...]}, top-level left_pct/used_pct)
// are still parsed. left = 100 - five_hour.used_pct; timestamp = snapshot.at ?? last_seen;
// resets_at from five_hour.resets_at; a profile OWNS several bucket `keys`.
function normalizeProfile(label, e) {
  if (!e || typeof e !== 'object') return null;
  const snap = e.last_windows_snapshot && typeof e.last_windows_snapshot === 'object' ? e.last_windows_snapshot : null;
  const fh = snap?.five_hour && typeof snap.five_hour === 'object' ? snap.five_hour : null;
  let left = clampPct(e.left_pct);
  if (left == null) {
    const used = clampPct(e.used_pct) ?? clampPct(e.five_hour?.used_pct) ?? clampPct(e.windows?.five_hour?.used_pct) ?? clampPct(fh?.used_pct);
    if (used != null) left = 100 - used;
  }
  const at = toEpochSec(e.updated_at ?? e.at ?? snap?.at ?? e.last_seen ?? e.seen_at);
  const name = [e.label, e.name, label].find((v) => typeof v === 'string' && v);
  if (!name || left == null || at == null) return null;
  const resets_at = toEpochSec(e.resets_at ?? e.five_hour?.resets_at ?? fh?.resets_at);
  const key = typeof e.key === 'string' && e.key ? e.key : typeof e.account === 'string' && e.account ? e.account : null;
  const keys = Array.isArray(e.keys) ? e.keys.filter((k) => typeof k === 'string' && k) : null;
  return { label: name, left_pct: left, at, resets_at, key, keys };
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
  else if (raw && typeof raw === 'object' && Array.isArray(raw.profiles)) for (const e of raw.profiles) entries.push(normalizeProfile(null, e));
  else if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object') for (const [k, v] of Object.entries(raw.profiles)) entries.push(normalizeProfile(k, v)); // tokenroom real shape
  else if (typeof raw === 'object') for (const [k, v] of Object.entries(raw)) entries.push(normalizeProfile(k, v));
  let best = null;
  for (const p of entries) {
    if (!p) continue;
    if (nowSec - p.at > STALE_SEC) continue; // known-fresh only
    if (p.resets_at != null && nowSec >= p.resets_at) continue; // post-reset reading is wrong-signed (readBudget crossedReset lesson) — don't trust the %
    if (currentKey && ((p.key && p.key === currentKey) || (p.keys && p.keys.includes(currentKey)))) continue; // that's us (single key OR one of this profile's buckets)
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
