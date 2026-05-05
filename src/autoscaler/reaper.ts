/**
 * Reaper — marks media_nodes rows as 'dead' and destroys their Hetzner
 * servers when we haven't heard from them.
 *
 * Two stale paths:
 *   - active/draining nodes whose heartbeat is older than STALE_AFTER_SECONDS
 *     (or never happened)
 *   - provisioning nodes whose bootstrap silently failed: created over
 *     PROVISION_TIMEOUT_SECONDS ago and still no heartbeat. Without this we
 *     accumulate ghost servers that never come online but keep billing.
 *
 * After flipping `state` to 'dead', the reaper calls Hetzner DELETE so the
 * server stops costing money. If the Hetzner call fails the row stays as
 * 'dead' and the next tick retries.
 */

import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client';
import { mediaNodes } from '../db/schema';
import { logger } from '../lib/logger';
import { logDecision } from './state';
import { deleteServer } from '../integrations/hetzner';

const STALE_AFTER_SECONDS = 60;
const PROVISION_TIMEOUT_SECONDS = 600;

export async function reaper(shadow: boolean): Promise<number> {
  const heartbeatCutoff = new Date(Date.now() - STALE_AFTER_SECONDS * 1000);
  const provisionCutoff = new Date(Date.now() - PROVISION_TIMEOUT_SECONDS * 1000);

  const stale = await db
    .select({
      id: mediaNodes.id,
      hetznerId: mediaNodes.hetznerId,
      state: mediaNodes.state,
      lastHeartbeatAt: mediaNodes.lastHeartbeatAt,
      createdAt: mediaNodes.createdAt,
    })
    .from(mediaNodes)
    .where(
      or(
        and(
          or(eq(mediaNodes.state, 'active'), eq(mediaNodes.state, 'draining')),
          // Compare against a JS Date, not raw SQL — drizzle's bind for raw
          // intervals via sql.raw can mis-stringify and crash with
          // "argument must be of type string ... Received an instance of Date".
          or(isNull(mediaNodes.lastHeartbeatAt), lt(mediaNodes.lastHeartbeatAt, heartbeatCutoff)),
        ),
        and(
          eq(mediaNodes.state, 'provisioning'),
          isNull(mediaNodes.lastHeartbeatAt),
          lt(mediaNodes.createdAt, provisionCutoff),
        ),
      ),
    );

  if (stale.length === 0) return 0;

  for (const n of stale) {
    const reason = n.state === 'provisioning'
      ? `bootstrap timed out (>${PROVISION_TIMEOUT_SECONDS}s, no heartbeat)`
      : `no heartbeat for >${STALE_AFTER_SECONDS}s (was ${n.state})`;

    await db.update(mediaNodes).set({ state: 'dead' }).where(eq(mediaNodes.id, n.id));
    await logDecision({ kind: 'reap', nodeId: n.id, reason, shadow });

    if (shadow) {
      logger.info({ nodeId: n.id, hetznerId: n.hetznerId, wasState: n.state }, '[autoscaler] reaped (shadow — no Hetzner delete)');
      continue;
    }

    if (n.hetznerId) {
      try {
        await deleteServer(Number(n.hetznerId));
        await db.delete(mediaNodes).where(eq(mediaNodes.id, n.id));
        logger.info({ nodeId: n.id, hetznerId: n.hetznerId, wasState: n.state }, '[autoscaler] reaped + destroyed');
      } catch (err: any) {
        logger.warn({ err: err?.message ?? String(err), nodeId: n.id, hetznerId: n.hetznerId }, '[autoscaler] hetzner delete failed; row left as dead for retry');
      }
    } else {
      await db.delete(mediaNodes).where(eq(mediaNodes.id, n.id));
      logger.info({ nodeId: n.id, wasState: n.state }, '[autoscaler] reaped (no hetzner_id)');
    }
  }

  return stale.length;
}
