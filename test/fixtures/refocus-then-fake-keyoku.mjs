#!/usr/bin/env node
// L2-1 race harness: simulates a concurrent session focusing a DIFFERENT goal inside
// loopDisarm's child-spawn window (pre-spawn focus read → goal_unfocus RPC). On startup
// it rewrites $KEYOKU_HOME/focus.json to $REFOCUS_GOAL_ID — exactly the end state a
// completing belay_loop_create leaves — then serves exactly like fake-keyoku.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.KEYOKU_HOME && process.env.REFOCUS_GOAL_ID) {
  writeFileSync(
    join(process.env.KEYOKU_HOME, 'focus.json'),
    JSON.stringify({ goalId: process.env.REFOCUS_GOAL_ID, at: new Date().toISOString() })
  );
}
await import('./fake-keyoku.mjs');
