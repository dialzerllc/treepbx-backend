/**
 * Autoscaler observer — reads the world.
 *
 * Three signals we care about:
 *   activeCc       — how many calls are active right now (from the calls table)
 *   forecastCc     — predicted load over the next ~5min from running campaigns
 *   carrierCeiling — total trunk capacity we're allowed to dial across
 *
 * `targetCc` is `min(max(activeCc, forecastCc) * 1.3, carrierCeiling)` — the planner uses it.
 */

import { and, eq, sql, gte } from 'drizzle-orm';
import { db } from '../db/client';
import { calls, campaigns, byocCarriers, mediaNodes } from '../db/schema';
import { getPerNodeCapacity } from './state';

const HEADROOM = 1.3;

export interface Observation {
  activeCc: number;
  forecastCc: number;
  carrierCeiling: number;
  targetCc: number;
  perNodeCapacity: number;
  nodes: {
    total: number;
    active: number;
    draining: number;
    stale: number;        // heartbeat >60s ago
  };
}

export async function observer(): Promise<Observation> {
  const [{ active }] = await db.select({
    active: sql<number>`count(*)::int`,
  }).from(calls).where(sql`status IN ('ringing','active','answered')`);

  const [{ forecast }] = await db.select({
    forecast: sql<number>`coalesce(sum((dial_ratio)::numeric * 4), 0)::int`,  // rough heuristic
  }).from(campaigns).where(eq(campaigns.status, 'running'));

  const [{ ceiling }] = await db.select({
    ceiling: sql<number>`coalesce(sum(max_channels), 0)::int`,
  }).from(byocCarriers);

  const rawTarget = Math.max(active ?? 0, forecast ?? 0) * HEADROOM;
  const targetCc = Math.min(rawTarget, Math.max(ceiling ?? 0, rawTarget));
  // ^ If ceiling is 0 (no BYOC configured), don't block on it — treat as unlimited
  // at the autoscaler level. Real backstops apply at the dialer.

  const nodeCounts = await db.select({
    state: mediaNodes.state,
    n: sql<number>`count(*)::int`,
    stale: sql<number>`count(*) FILTER (WHERE last_heartbeat_at < now() - interval '60 seconds')::int`,
  }).from(mediaNodes).groupBy(mediaNodes.state);

  const countOf = (s: string) => nodeCounts.find((r) => r.state === s)?.n ?? 0;
  const staleSum = nodeCounts.reduce((a, r) => a + (r.stale ?? 0), 0);

  return {
    activeCc: active ?? 0,
    forecastCc: forecast ?? 0,
    carrierCeiling: ceiling ?? 0,
    targetCc: Math.ceil(targetCc),
    perNodeCapacity: await getPerNodeCapacity(),
    nodes: {
      total: nodeCounts.reduce((a, r) => a + (r.n ?? 0), 0),
      active: countOf('active'),
      draining: countOf('draining'),
      stale: staleSum,
    },
  };
}
