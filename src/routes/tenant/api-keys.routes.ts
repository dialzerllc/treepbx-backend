import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../../db/client';
import { apiKeys, webhooks } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const apiKeySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).nullable().default([]),
  rateLimit: z.coerce.number().int().default(1000),
  expiresAt: z.string().nullable().optional().transform((v) => v && v.length > 5 ? v : null),
});

const webhookSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  events: z.array(z.string()).nullable().default([]),
  active: z.boolean().nullable().default(true),
});

// List API keys
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = eq(apiKeys.tenantId, tenantId);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      rateLimit: apiKeys.rateLimit,
      active: apiKeys.active,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    }).from(apiKeys).where(where).orderBy(desc(apiKeys.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(apiKeys).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Webhooks sub-routes — must be before /:id to avoid route shadowing
router.get('/webhooks', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select({
    id: webhooks.id,
    name: webhooks.name,
    url: webhooks.url,
    events: webhooks.events,
    active: webhooks.active,
    failureCount: webhooks.failureCount,
    lastDeliveryAt: webhooks.lastDeliveryAt,
    lastDeliveryStatus: webhooks.lastDeliveryStatus,
    createdAt: webhooks.createdAt,
  }).from(webhooks).where(eq(webhooks.tenantId, tenantId)).orderBy(desc(webhooks.createdAt));
  return c.json({ data: rows });
});

router.post('/webhooks', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = webhookSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: webhooks.id }).from(webhooks)
    .where(and(eq(webhooks.name, body.name), eq(webhooks.tenantId, tenantId)));
  if (dup) throw new BadRequest('Webhook name already exists');
  const secret = nanoid(32);
  const [row] = await db.insert(webhooks).values({ ...body, tenantId, secret }).returning();
  return c.json({ ...row, secret }, 201);
});

router.put('/webhooks/:wid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = webhookSchema.partial().parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: webhooks.id }).from(webhooks)
      .where(and(eq(webhooks.name, body.name), eq(webhooks.tenantId, tenantId), sql`${webhooks.id} != ${c.req.param('wid')}`));
    if (dup) throw new BadRequest('Webhook name already exists');
  }
  const [row] = await db.update(webhooks).set(body)
    .where(and(eq(webhooks.id, c.req.param('wid')), eq(webhooks.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Webhook not found');
  return c.json(row);
});

router.delete('/webhooks/:wid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(webhooks)
    .where(and(eq(webhooks.id, c.req.param('wid')), eq(webhooks.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Webhook not found');
  return c.json({ ok: true });
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    keyPrefix: apiKeys.keyPrefix,
    scopes: apiKeys.scopes,
    rateLimit: apiKeys.rateLimit,
    active: apiKeys.active,
    expiresAt: apiKeys.expiresAt,
    lastUsedAt: apiKeys.lastUsedAt,
    createdAt: apiKeys.createdAt,
  }).from(apiKeys)
    .where(and(eq(apiKeys.id, c.req.param('id')), eq(apiKeys.tenantId, tenantId)));
  if (!row) throw new NotFound('API key not found');
  return c.json(row);
});

// Create API key - generate once, return once
router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const body = apiKeySchema.parse(await c.req.json());
  const [dup] = await db.select({ id: apiKeys.id }).from(apiKeys)
    .where(and(eq(apiKeys.name, body.name), eq(apiKeys.tenantId, tenantId)));
  if (dup) throw new BadRequest('API key name already exists');

  const rawKey = `tpbx_${nanoid(32)}`;
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = Bun.hash(rawKey).toString();

  const [row] = await db.insert(apiKeys).values({
    ...body,
    tenantId,
    userId,
    keyHash,
    keyPrefix,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
  }).returning();

  // Return the full key only once
  return c.json({ ...row, key: rawKey }, 201);
});

// Update API key (toggle active, update scopes/name)
router.put('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    name: z.string().min(1).optional(),
    active: z.boolean().optional(),
    scopes: z.array(z.string()).optional(),
    rateLimit: z.coerce.number().int().default(1).optional(),
  }).passthrough().parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: apiKeys.id }).from(apiKeys)
      .where(and(eq(apiKeys.name, body.name), eq(apiKeys.tenantId, tenantId), sql`${apiKeys.id} != ${c.req.param('id')}`));
    if (dup) throw new BadRequest('API key name already exists');
  }

  const [row] = await db.update(apiKeys).set(body)
    .where(and(eq(apiKeys.id, c.req.param('id')), eq(apiKeys.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('API key not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(apiKeys)
    .where(and(eq(apiKeys.id, c.req.param('id')), eq(apiKeys.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('API key not found');
  return c.json({ ok: true });
});

export default router;
