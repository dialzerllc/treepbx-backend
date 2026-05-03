/**
 * Autoscaler executor — turns a Plan into real Hetzner provisions / drains.
 *
 * Side-effecting counterpart to the pure planner. Two responsibilities:
 *   1. Provision: fire Hetzner createServer + insert media_nodes row in
 *      'provisioning' state. The on-box tpbx-agent registers + flips it
 *      to 'active' as soon as cloud-init finishes.
 *   2. Drain: flip a media_nodes row to 'draining'. The reaper / on-box
 *      agent handles the rest (refuse new INVITEs; once activeCalls=0,
 *      call terminate() which deletes the Hetzner server + media_nodes row).
 *
 * Failure mode: if Hetzner createServer fails midway through a batch, we
 * stop early and surface the error. The planner will retry on the next
 * tick (after cooldown). No partial-rollback — Hetzner-side stragglers
 * (created server, no media_nodes row) get cleaned up by the next observer
 * pass which now flags them as orphans.
 */

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { mediaNodes } from '../db/schema';
import { createServer, deleteServer } from '../integrations/hetzner';
import { PROFILES } from './catalog';
import { logger } from '../lib/logger';

export interface ProvisionRequest {
  count: number;
  serviceType: string;            // 'freeswitch' | 'media' | 'sip_proxy' | 'db' | ...
  location?: string;              // default 'fsn1'
  pool?: string;                  // default 'baseline'
  serverType?: string;            // override; otherwise picks the smallest preferred
}

export interface ProvisionResult {
  hetznerId: number;
  nodeId: string;
  name: string;
  publicIp: string;
}

const DEFAULT_LOCATION = 'fsn1';
const DEFAULT_POOL = 'baseline';

function pickServerType(serviceType: string, override?: string): string {
  if (override) return override;
  const profile = PROFILES[serviceType];
  if (!profile) throw new Error(`autoscaler executor: unknown service '${serviceType}'`);
  // The smallest preferred — autoscaler scales horizontally, not vertically.
  // Operators can pin a larger size via the rule's serverType column.
  return profile.preferred[0];
}

function capacityFor(serviceType: string, serverType: string): number {
  const profile = PROFILES[serviceType];
  const cap = profile?.capacityFor?.[serverType];
  if (typeof cap === 'number') return cap;
  // Reasonable default if the type isn't in the catalog (e.g. db-only nodes).
  return 1;
}

function namePrefix(serviceType: string): string {
  // Hetzner server names allow [a-z0-9-]. Mirror existing convention:
  // freeswitch → 'fs', sip_proxy → 'sip', media → 'media', db → 'db'.
  switch (serviceType) {
    case 'freeswitch': return 'fs';
    case 'sip_proxy':  return 'sip';
    default: return serviceType.replace(/_/g, '-');
  }
}

/**
 * Allocates a unique server name for a (service, location) by counting existing
 * media_nodes and using the next free integer suffix. This is best-effort under
 * concurrency — Hetzner will reject duplicate names so a race just costs us a
 * retry, not a duplicate provision.
 */
async function allocateName(serviceType: string, location: string): Promise<string> {
  const prefix = `${namePrefix(serviceType)}-${location}-`;
  const rows = await db.select({ id: mediaNodes.id })
    .from(mediaNodes)
    .where(and(eq(mediaNodes.serviceType, serviceType), eq(mediaNodes.location, location)));
  const next = rows.length + 1;
  return `${prefix}${next}`;
}

export async function executeProvision(req: ProvisionRequest): Promise<ProvisionResult[]> {
  if (req.count <= 0) return [];
  const location = req.location ?? DEFAULT_LOCATION;
  const pool = req.pool ?? DEFAULT_POOL;
  const serverType = pickServerType(req.serviceType, req.serverType);
  const capacityCc = capacityFor(req.serviceType, serverType);

  const out: ProvisionResult[] = [];
  for (let i = 0; i < req.count; i++) {
    const name = await allocateName(req.serviceType, location);
    logger.info({ name, serverType, location, serviceType: req.serviceType }, '[executor] provisioning');
    try {
      const resp = await createServer(name, serverType, location);
      const s = (resp as any).server;
      const publicIp = s.public_net?.ipv4?.ip ?? '0.0.0.0';
      const [row] = await db.insert(mediaNodes).values({
        hetznerId: Number(s.id),
        pool,
        serverType,
        publicIp,
        capacityCc,
        imageVersion: 'ubuntu-22.04',
        state: 'provisioning',
        serviceType: req.serviceType,
        location,
      }).returning();
      out.push({ hetznerId: Number(s.id), nodeId: row.id, name, publicIp });
      logger.info({ hetznerId: s.id, nodeId: row.id, name, publicIp }, '[executor] provisioned');
    } catch (err: any) {
      logger.error({ err: err?.message ?? String(err), name }, '[executor] provision failed');
      throw err;
    }
  }
  return out;
}

/** Mark nodes as draining so on-box agents stop accepting new traffic. */
export async function executeDrain(nodeIds: string[]): Promise<number> {
  if (nodeIds.length === 0) return 0;
  let n = 0;
  for (const id of nodeIds) {
    const [row] = await db.update(mediaNodes)
      .set({ state: 'draining', drainStartedAt: new Date() })
      .where(eq(mediaNodes.id, id))
      .returning({ id: mediaNodes.id });
    if (row) n++;
  }
  logger.info({ drained: n }, '[executor] drained');
  return n;
}

/**
 * Terminate a fully-drained node — call Hetzner deleteServer + remove the
 * media_nodes row. Caller is responsible for ensuring activeCalls==0 (or that
 * the hard 10-min termination cap has elapsed).
 */
export async function executeTerminate(nodeId: string): Promise<boolean> {
  const [node] = await db.select().from(mediaNodes).where(eq(mediaNodes.id, nodeId));
  if (!node) return false;
  try {
    await deleteServer(Number(node.hetznerId));
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err), hetznerId: node.hetznerId }, '[executor] hetzner delete failed (may already be gone)');
  }
  await db.delete(mediaNodes).where(eq(mediaNodes.id, nodeId));
  logger.info({ nodeId, hetznerId: node.hetznerId }, '[executor] terminated');
  return true;
}
