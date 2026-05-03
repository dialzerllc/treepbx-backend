/**
 * Reaper — marks media_nodes rows as 'dead' when we haven't heard from them.
 *
 * A node is stale if it has been `active` or `draining` and its last heartbeat
 * is older than STALE_AFTER_SECONDS (or never happened). Reaping just flips
 * `state` to 'dead' in the DB — we do not touch Hetzner from here. Actual
 * server destruction is the autoscaler executor's job (still to be built).
 *
 * Why separate state: `terminating` means "autoscaler is actively destroying
 * this server". `dead` means "it stopped checking in; we don't know what
 * happened". Keeping those distinct preserves the root cause for post-mortems.
 */

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { mediaNodes } from '../db/schema';
import { logger } from '../lib/logger';
import { logDecision } from './state';

const STALE_AFTER_SECONDS = 60;

export async function reaper(shadow: boolean): Promise<number> {
  const stale = await db
    .select({
      id: mediaNodes.id,
      hetznerId: mediaNodes.hetznerId,
      state: mediaNodes.state,
      lastHeartbeatAt: mediaNodes.lastHeartbeatAt,
    })
    .from(mediaNodes)
    .where(
      and(
        or(eq(mediaNodes.state, 'active'), eq(mediaNodes.state, 'draining')),
        or(
          isNull(mediaNodes.lastHeartbeatAt),
          // Compare against a JS Date, not raw SQL — drizzle's bind for raw
          // intervals via sql.raw can mis-stringify and crash with
          // "argument must be of type string ... Received an instance of Date".
          lt(mediaNodes.lastHeartbeatAt, new Date(Date.now() - STALE_AFTER_SECONDS * 1000)),
        ),
      ),
    );

  if (stale.length === 0) return 0;

  for (const n of stale) {
    await db.update(mediaNodes).set({ state: 'dead' }).where(eq(mediaNodes.id, n.id));
    await logDecision({
      kind: 'reap',
      nodeId: n.id,
      reason: `no heartbeat for >${STALE_AFTER_SECONDS}s (was ${n.state})`,
      shadow,
    });
    logger.info(
      { nodeId: n.id, hetznerId: n.hetznerId, wasState: n.state, lastHeartbeatAt: n.lastHeartbeatAt },
      '[autoscaler] reaped stale media node',
    );
  }

  return stale.length;
}
