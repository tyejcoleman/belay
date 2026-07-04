import { join } from 'node:path';
import { belayDir, readJSON, readConfig, readStdin, ensureDir, atomicWriteJSON, sanitizeText, capReason } from './util.mjs';
import { scan } from './propose.mjs';
import { buildLoopBriefing } from './compose.mjs';

// The SessionStart hook — the morning briefing (docs/DESIGN.md §4.2). Official surface:
// hookSpecificOutput.additionalContext (same channel tokenroom uses). Wired by
// `belay install` as `belay hook session-start` (additive, MARK-owned).
//
// Contract (frozen round 0):
// - Read the stdin payload, run propose.scan() (persists as it scans), emit the top
//   cfg.proposal_max_surfaced (default 3) OPEN proposals as additionalContext.
// - Each line sanitizeText'd, whole block capReason'd ≤1.5KB (ADR-7: resume summaries,
//   goal slugs, ripe text are all file-controlled input — sanitized again HERE at the
//   boundary, belt-and-suspenders over propose.mjs's own sanitization).
// - Zero open proposals → ZERO output (silent no-op posture). ANY error → silent exit 0
//   (never-crash rule; bin's hook try/catch is the outer net, inner one kept like hookStop).
//   Fires on every session start incl. compaction restarts — pure file reads, <50ms.
// - Proposals are surfaced, never armed here: no keyoku write, no loops.json write, no
//   spawn of any kind from a hook (ADR-1/ADR-11). The only write is the belay-local
//   surfaced_count bookkeeping in proposals.json.

const MAX_CONTEXT_BYTES = 1536; // 1.5KB — DESIGN §4.2 / ADR-11 flood cap
const MAX_LINE = 300; // per-proposal line cap (summary itself is already ≤200)

/**
 * Entry point for `belay hook session-start`.
 * Emits { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } } on
 * stdout when there are open proposals; otherwise emits nothing.
 * @returns {Promise<void>}
 */
export async function hookSessionStart() {
  // Consume the payload (nothing in it changes the scan — scan scopes by files), but
  // BOUNDED: a caller that never closes stdin must not wedge the hook (ADR-4; the
  // harness's own hook timeout is the outer net, this is the inner one). The payload
  // arrives-and-closes within ms in the real harness, so the race is normally a no-op.
  let payload = {};
  try {
    payload = (await Promise.race([readStdin(), new Promise((resolve) => setTimeout(() => resolve({}), 250).unref?.())])) || {};
    process.stdin.unref?.(); // a still-pending read must not hold the process open
  } catch {
    // stdin quirks are not our problem — proceed without the payload
  }
  try {
    const { cfg } = readConfig();

    // (1) Compaction re-briefing (ADR-21): if THIS session is mid-flight on a live loop, lead
    // with the loop's objective/unmet/counters/budget so a compacted restart isn't blind. Pure
    // file read, independent of proposals_enabled (it is not a proposal — it is the active loop).
    let briefing = null;
    try {
      briefing = buildLoopBriefing({ session_id: typeof payload.session_id === 'string' ? payload.session_id : undefined, cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined });
    } catch {
      // briefing is best-effort — never block the hook
    }

    // (2) Proposals — the morning briefing of loop-worthy work elsewhere (advisory, never armed).
    let proposalsLine = null;
    if (cfg.proposals_enabled) {
      const open = scan().proposals.filter((p) => p && typeof p === 'object' && p.status === 'open');
      const top = open.slice(0, cfg.proposal_max_surfaced);
      if (top.length > 0) {
        const items = top.map((p, i) => sanitizeText(`(${i + 1}) ${p.kind} [${p.id}]: ${p.summary}`, MAX_LINE));
        proposalsLine = `[belay] ${open.length} loop proposal${open.length === 1 ? '' : 's'} open: ${items.join(' ')} — arm one with belay_loop_create({ proposal_id: <id>, … }) or dismiss via belay_propose({ dismiss: <id> }). Proposals are advisory; arming is your explicit call.`;

        // surfaced_count bookkeeping (belay-local, best-effort — never blocks the surfacing)
        try {
          const path = join(belayDir(), 'proposals.json');
          const s = readJSON(path);
          if (s && typeof s === 'object' && Array.isArray(s.proposals)) {
            const ids = new Set(top.map((p) => p.id));
            for (const p of s.proposals) {
              if (p && typeof p === 'object' && ids.has(p.id)) p.surfaced_count = (typeof p.surfaced_count === 'number' && Number.isFinite(p.surfaced_count) ? p.surfaced_count : 0) + 1;
            }
            ensureDir(belayDir());
            atomicWriteJSON(path, s);
          }
        } catch {
          // bookkeeping only
        }
      }
    }

    const blocks = [briefing, proposalsLine].filter(Boolean);
    if (blocks.length === 0) return; // silence is the posture (ADR-4)
    const context = capReason(blocks.join('\n\n'), MAX_CONTEXT_BYTES);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  } catch {
    // ANY error = silent exit 0: a hook must never break the harness (ADR-4)
  }
}
