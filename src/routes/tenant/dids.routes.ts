import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { dids, didGroups, byocCarriers, platformDids } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const didSchema = z.object({
  number: z.string().min(1),
  description: z.string().optional(),
  country: z.string().default('US'),
  city: z.string().optional(),
  state: z.string().optional(),
  didType: z.enum(['local', 'tollfree', 'international']).default('local'),
  didGroupId: z.string().uuid().nullable().optional(),
  byocCarrierId: z.string().uuid().nullable().optional(),
  active: z.boolean().default(true),
  routeType: z.string().default('ivr'),
  routeTargetId: z.string().uuid().nullable().optional(),
  unknownCallerRoute: z.string().optional(),
  repeatCallerRoute: z.string().optional(),
  platformDidId: z.string().uuid().nullable().optional(),
});

const didGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  strategy: z.enum(['round_robin', 'sequential', 'random']).default('round_robin'),
  defaultRoute: z.string().optional(),
  callerIdStrategy: z.enum(['fixed', 'random', 'local_match']).default('fixed'),
});

const byocSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().default(5060),
  transport: z.enum(['UDP', 'TCP', 'TLS']).default('UDP'),
  codec: z.string().default('G.711'),
  username: z.string().optional(),
  password: z.string().optional(),
  maxChannels: z.number().int().positive().default(50),
  ratePerMinute: z.union([z.number(), z.string()]).transform(String).optional(),
});

// List DIDs
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    active: z.coerce.boolean().optional(),
    didGroupId: z.string().uuid().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(dids.tenantId, tenantId)];
  if (raw.search) conditions.push(like(dids.number, `%${raw.search}%`));
  if (raw.active !== undefined) conditions.push(eq(dids.active, raw.active));
  if (raw.didGroupId) conditions.push(eq(dids.didGroupId, raw.didGroupId));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(dids).where(where).orderBy(desc(dids.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(dids).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Named routes must be before /:id to avoid route shadowing
router.get('/available', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const rows = await db.select().from(platformDids)
    .where(eq(platformDids.status, 'available'))
    .orderBy(desc(platformDids.createdAt)).limit(limit).offset(offset);
  return c.json(rows);
});

// DID Groups sub-routes
router.get('/groups', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select().from(didGroups)
    .where(eq(didGroups.tenantId, tenantId)).orderBy(desc(didGroups.createdAt));
  return c.json(rows);
});

router.post('/groups', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = didGroupSchema.parse(await c.req.json());
  const [row] = await db.insert(didGroups).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/groups/:gid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = didGroupSchema.partial().parse(await c.req.json());
  const [row] = await db.update(didGroups).set(body)
    .where(and(eq(didGroups.id, c.req.param('gid')), eq(didGroups.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('DID group not found');
  return c.json(row);
});

router.delete('/groups/:gid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(didGroups)
    .where(and(eq(didGroups.id, c.req.param('gid')), eq(didGroups.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('DID group not found');
  return c.json({ ok: true });
});

// BYOC carriers sub-routes
router.get('/byoc', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select({
    id: byocCarriers.id,
    name: byocCarriers.name,
    host: byocCarriers.host,
    port: byocCarriers.port,
    transport: byocCarriers.transport,
    codec: byocCarriers.codec,
    username: byocCarriers.username,
    maxChannels: byocCarriers.maxChannels,
    ratePerMinute: byocCarriers.ratePerMinute,
    status: byocCarriers.status,
    registered: byocCarriers.registered,
    createdAt: byocCarriers.createdAt,
  }).from(byocCarriers).where(eq(byocCarriers.tenantId, tenantId)).orderBy(desc(byocCarriers.createdAt));
  return c.json(rows);
});

router.post('/byoc', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = byocSchema.parse(await c.req.json());
  const { password, ...rest } = body;
  const { hashPassword } = await import('../../lib/password');
  const passwordHash = password ? await hashPassword(password) : undefined;
  const [row] = await db.insert(byocCarriers).values({ ...rest, tenantId, ...(passwordHash ? { passwordHash } : {}) }).returning();
  return c.json(row, 201);
});

router.put('/byoc/:bid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = byocSchema.partial().parse(await c.req.json());
  const { password, ...rest } = body;
  const { hashPassword } = await import('../../lib/password');
  const passwordHash = password ? await hashPassword(password) : undefined;
  const [row] = await db.update(byocCarriers)
    .set({ ...rest, ...(passwordHash ? { passwordHash } : {}) })
    .where(and(eq(byocCarriers.id, c.req.param('bid')), eq(byocCarriers.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('BYOC carrier not found');
  return c.json(row);
});

router.delete('/byoc/:bid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(byocCarriers)
    .where(and(eq(byocCarriers.id, c.req.param('bid')), eq(byocCarriers.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('BYOC carrier not found');
  return c.json({ ok: true });
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(dids)
    .where(and(eq(dids.id, c.req.param('id')), eq(dids.tenantId, tenantId)));
  if (!row) throw new NotFound('DID not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = didSchema.parse(await c.req.json());
  const [row] = await db.insert(dids).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = didSchema.partial().omit({ number: true }).parse(await c.req.json());
  const [row] = await db.update(dids).set(body)
    .where(and(eq(dids.id, c.req.param('id')), eq(dids.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('DID not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(dids)
    .where(and(eq(dids.id, c.req.param('id')), eq(dids.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('DID not found');
  return c.json({ ok: true });
});

export default router;
