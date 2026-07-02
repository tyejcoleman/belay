// The SessionStart hook — the morning briefing (docs/DESIGN.md §4.2). Official surface:
// hookSpecificOutput.additionalContext (same channel tokenroom uses). Owner: agent C
// (round 1). Wired by `belay install` as `belay hook session-start` (additive, MARK-owned).
//
// ROUND-0 CONTRACT (FROZEN):
// - Read the stdin payload, run propose.scan() (persists as it scans), emit the top
//   cfg.proposal_max_surfaced (default 3) OPEN proposals as additionalContext:
//     "[belay] N loop proposals open: (1) <kind>: <summary> — arm with
//      belay_loop_create({…}) or dismiss via belay_propose. Proposals are advisory;
//      arming is your explicit call."
// - Each line sanitizeText'd, whole block capReason'd ≤1.5KB (ADR-7: resume summaries,
//   goal slugs, ripe text are all file-controlled input).
// - Zero open proposals → ZERO output (silent no-op posture). ANY error → silent exit 0
//   (never-crash rule; bin's hook try/catch is the outer net, keep an inner one too like
//   hookStop). Fires on every session start incl. compaction restarts — must stay <50ms.
// - Proposals are surfaced, never armed here: no keyoku write, no loops.json write, no
//   spawn of any kind from a hook (ADR-1/ADR-11).

const notImplemented = (fn) => Object.assign(new Error(`belay: ${fn} not implemented (round-0 stub — see docs/DESIGN.md)`), { code: 'ERR_NOT_IMPLEMENTED' });

/**
 * Entry point for `belay hook session-start`.
 * Emits { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } } on
 * stdout when there are open proposals; otherwise emits nothing. Never throws to the
 * caller in round 1 (inner try/catch → silent); the round-0 stub throws NotImplemented,
 * which bin's hook choke-point catch turns into today's silent exit 0.
 * @returns {Promise<void>}
 */
export async function hookSessionStart() {
  throw notImplemented('hookSessionStart');
}
