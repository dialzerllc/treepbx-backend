/**
 * Autoscaler observer — reads the world.
 *
 * Returns a per-service observation. Each service has its own load metric:
 *   freeswitch — concurrent calls (active + forecasted); HEADROOM applied
 *   sip_proxy  — currently logged-in agents (proxy for SIP registrations)
 *
 * Node counts are filtered by service_type so the planner's "healthy" count
 * is correct per scope. Without that filter, FS planner would count sip/media
 * nodes as FS capacity.
 */

import { eq, sql, and, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { calls, campaigns, byocCarriers, mediaNodes, agentSessions } from '../db/schema';
import { getPerNodeCapacity } from './state';

const HEADROOM = 1.3;

export interface ServiceObservation {
  serviceType: string;
  load: number;             // service-specific (calls for fs, regs for sip)
  perNodeCapacity: number;
  carrierCeiling: number;   // 0 unless service=freeswitch
  targetCc: number;         // load × HEADROOM, capped where applicable
  nodes: {
    total: number;
    active: number;
    draining: number;
    stale: number;
  };
}

export interface Observation {
  freeswitch: ServiceObservation;
  sip_proxy: ServiceObservation;
}

async function nodeStats(serviceType: string) {
  const rows = await db.select({
    state: mediaNodes.state,
    n: sql<number>`count(*)::int`,
    stale: sql<number>`count(*) FILTER (WHERE last_heartbeat_at < now() - interval '60 seconds')::int`,
  })
    .from(mediaNodes)
    .where(eq(mediaNodes.serviceType, serviceType))
    .groupBy(mediaNodes.state);
  const countOf = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
  return {
    total: rows.reduce((a, r) => a + (r.n ?? 0), 0),
    active: countOf('active'),
    draining: countOf('draining'),
    stale: rows.reduce((a, r) => a + (r.stale ?? 0), 0),
  };
}

async function freeswitchObs(perNode: number): Promise<ServiceObservation> {
  const [{ active }] = await db.select({
    active: sql<number>`count(*)::int`,
  }).from(calls).where(sql`status IN ('ringing','active','answered')`);

  const [{ forecast }] = await db.select({
    forecast: sql<number>`coalesce(sum((dial_ratio)::numeric * 4), 0)::int`,
  }).from(campaigns).where(eq(campaigns.status, 'running'));

  const [{ ceiling }] = await db.select({
    ceiling: sql<number>`coalesce(sum(max_channels), 0)::int`,
  }).from(byocCarriers);

  const load = Math.max(active ?? 0, forecast ?? 0);
  const rawTarget = load * HEADROOM;
  const targetCc = Math.ceil(Math.min(rawTarget, Math.max(ceiling ?? 0, rawTarget)));
  // ^ ceiling=0 (no BYOC) → don't block; treat as unlimited at the autoscaler level.

  return {
    serviceType: 'freeswitch',
    load,
    perNodeCapacity: perNode,
    carrierCeiling: ceiling ?? 0,
    targetCc,
    nodes: await nodeStats('freeswitch'),
  };
}

async function sipProxyObs(perNode: number): Promise<ServiceObservation> {
  // Online agents = active sessions (logout_at IS NULL). This is a proxy for
  // current SIP registration count — close enough as a scale-up trigger; the
  // real Kamailio ul_dump count would be more accurate but requires reachable
  // RPC from ctl02.
  const [{ regs }] = await db.select({
    regs: sql<number>`count(*)::int`,
  }).from(agentSessions).where(isNull(agentSessions.logoutAt));

  return {
    serviceType: 'sip_proxy',
    load: regs ?? 0,
    perNodeCapacity: perNode,
    carrierCeiling: 0,
    targetCc: Math.ceil((regs ?? 0) * HEADROOM),
    nodes: await nodeStats('sip_proxy'),
  };
}

export async function observer(): Promise<Observation> {
  const perNode = await getPerNodeCapacity();
  const [fs, sip] = await Promise.all([
    freeswitchObs(perNode),
    sipProxyObs(perNode),
  ]);
  return { freeswitch: fs, sip_proxy: sip };
}
