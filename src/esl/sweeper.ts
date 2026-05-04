import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { logger } from '../lib/logger';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

// Global call sweeper — runs independently of any campaign tick.
// Catches CDRs that the per-campaign sweeper would never reach (paused
// campaigns, manual calls, or rows where ended_at was set but status was
// not flipped). Without this, leaked rows surface as "live calls" forever.
async function tick() {
  try {
    // Case 1: ended_at is set but status still ringing/answered — pure
    // status-vs-ended inconsistency. Fix without touching ended_at.
    const r1 = await db.execute(sql`
      UPDATE calls
         SET status = 'completed'
       WHERE status IN ('ringing', 'answered')
         AND ended_at IS NOT NULL
       RETURNING id
    `);

    // Case 2: status ringing/answered, ended_at null, started > 5 min ago.
    // Hangup events were missed by FS or the listener was disconnected.
    const r2 = await db.execute(sql`
      UPDATE calls
         SET status = 'completed',
             hangup_cause = COALESCE(hangup_cause, 'STUCK_ORPHAN'),
             ended_at = NOW()
       WHERE status IN ('ringing', 'answered')
         AND ended_at IS NULL
         AND started_at <= NOW() - INTERVAL '5 minutes'
       RETURNING id
    `);

    const inconsistent = r1.length;
    const stuck = r2.length;
    if (inconsistent + stuck > 0) logger.info({ inconsistent, stuck }, '[sweeper] cleared stale calls');
  } catch (err) {
    logger.error({ err }, '[sweeper] tick failed');
  }
}

export function startGlobalCallSweeper() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  logger.info({ intervalMs: TICK_MS }, '[sweeper] global call sweeper started');
  // Run once on startup so leftover state from a crash clears immediately.
  tick();
}
