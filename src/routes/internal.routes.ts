import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { mediaNodes } from '../db/schema';
import { BadRequest, Unauthorized, NotFound } from '../lib/errors';
import { logger } from '../lib/logger';

const router = new Hono();

/**
 * Shared token for bootstrap calls from media nodes.
 * Set BOOTSTRAP_TOKEN in the backend .env and bake the same token into the
 * media-node Packer image (or inject via cloud-init).
 *
 * Why a shared token rather than per-node keys?
 *  - Node identity is established by the Hetzner API (we own both ends).
 *  - Per-node keys complicate the Packer image bake. The real authz is that
 *    the Hetzner ID + public IP must match what the autoscaler just provisioned.
 */
router.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/, '');
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected || !token || token !== expected) {
    throw new Unauthorized('Invalid bootstrap token');
  }
  await next();
});

const registerSchema = z.object({
  hetznerId: z.number().int(),
  pool: z.enum(['baseline', 'hot_spare', 'elastic']),
  serverType: z.string(),
  publicIp: z.string(),
  privateIp: z.string().optional(),
  capacityCc: z.number().int().min(1),
  imageVersion: z.string(),
});

/**
 * Media node calls this on first boot, after cloud-init finishes.
 * Idempotent — if the node already exists (e.g. process restart), update
 * its public IP and move back to 'active'.
 */
router.post('/media-nodes/register', async (c) => {
  const body = registerSchema.parse(await c.req.json());
  const [existing] = await db.select().from(mediaNodes).where(eq(mediaNodes.hetznerId, body.hetznerId));

  if (existing) {
    const [row] = await db.update(mediaNodes).set({
      publicIp: body.publicIp,
      privateIp: body.privateIp ?? existing.privateIp,
      state: 'active',
      lastHeartbeatAt: new Date(),
    }).where(eq(mediaNodes.id, existing.id)).returning();
    logger.info({ nodeId: row.id, hetznerId: body.hetznerId }, '[media-nodes] re-registered');
    return c.json({ nodeId: row.id, assigned: { bootstrapToken: '***' } });
  }

  const [row] = await db.insert(mediaNodes).values({
    hetznerId: body.hetznerId,
    pool: body.pool,
    serverType: body.serverType,
    publicIp: body.publicIp,
    privateIp: body.privateIp ?? null,
    capacityCc: body.capacityCc,
    imageVersion: body.imageVersion,
    state: 'active',
    lastHeartbeatAt: new Date(),
  }).returning();
  logger.info({ nodeId: row.id, hetznerId: body.hetznerId, pool: body.pool }, '[media-nodes] registered');
  return c.json({ nodeId: row.id }, 201);
});

const heartbeatSchema = z.object({
  activeCalls: z.number().int().min(0),
  cpuPct: z.number().min(0).max(100).optional(),
});

/**
 * Media node calls this every ~10s with live stats. If we haven't heard from a
 * node in >60s the autoscaler treats it as dead and schedules a replacement.
 *
 * If the node was previously reaped to 'dead' but is now heartbeating again,
 * lift it back to 'active'. Don't touch nodes mid-drain or mid-terminate —
 * those transitions are owned by the autoscaler executor.
 */
router.put('/media-nodes/:id/heartbeat', async (c) => {
  const body = heartbeatSchema.parse(await c.req.json());
  const [current] = await db.select({ state: mediaNodes.state }).from(mediaNodes).where(eq(mediaNodes.id, c.req.param('id')));
  if (!current) throw new NotFound('media node not registered');
  const reviveToActive = current.state === 'dead' || current.state === 'provisioning' || current.state === 'registering';
  const [row] = await db.update(mediaNodes).set({
    activeCalls: body.activeCalls,
    cpuPct: body.cpuPct ?? null,
    lastHeartbeatAt: new Date(),
    ...(reviveToActive ? { state: 'active' } : {}),
  }).where(eq(mediaNodes.id, c.req.param('id'))).returning();
  return c.json({ ok: true, state: row.state });
});

/**
 * Autoscaler calls this when it wants a node to stop accepting new calls.
 * The node's agent polls its own row's state — when it flips to 'draining'
 * it refuses new INVITEs. Actual server termination happens only once
 * active_calls drops to 0 (or the hard 10-min cap).
 */
router.post('/media-nodes/:id/drain', async (c) => {
  const [row] = await db.update(mediaNodes).set({
    state: 'draining',
    drainStartedAt: new Date(),
  }).where(eq(mediaNodes.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('media node not registered');
  logger.info({ nodeId: row.id }, '[media-nodes] drain requested');
  return c.json({ ok: true });
});

/**
 * Node reads this on boot to fetch config (SIP creds, BYOC carriers, rate limits).
 * Keeps sensitive config out of the Packer image.
 */
router.get('/media-config', async (c) => {
  return c.json({
    // TODO: surface per-tenant BYOC carriers, rate cards, dispatcher endpoint, etc.
    // For bootstrap this can stay empty — nodes still register and heartbeat.
    version: 1,
    controlPlaneHeartbeatUrl: '/api/v1/internal/media-nodes/HEARTBEAT_SELF',
  });
});

export default router;
