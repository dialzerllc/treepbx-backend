import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { crmIntegrations } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const crmSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['salesforce', 'hubspot', 'zoho', 'pipedrive', 'freshsales', 'custom']),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional', 'push', 'pull']).default('bidirectional')
    .transform((v) => v === 'push' ? 'outbound' : v === 'pull' ? 'inbound' : v),
  status: z.enum(['active', 'inactive', 'error']).default('active'),
  credentials: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
});

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = eq(crmIntegrations.tenantId, tenantId);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: crmIntegrations.id,
      tenantId: crmIntegrations.tenantId,
      name: crmIntegrations.name,
      provider: crmIntegrations.provider,
      syncDirection: crmIntegrations.syncDirection,
      status: crmIntegrations.status,
      config: crmIntegrations.config,
      lastSyncAt: crmIntegrations.lastSyncAt,
      contactsSynced: crmIntegrations.contactsSynced,
      callsSynced: crmIntegrations.callsSynced,
      createdAt: crmIntegrations.createdAt,
    }).from(crmIntegrations).where(where).orderBy(desc(crmIntegrations.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(crmIntegrations).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({
    id: crmIntegrations.id,
    name: crmIntegrations.name,
    provider: crmIntegrations.provider,
    syncDirection: crmIntegrations.syncDirection,
    status: crmIntegrations.status,
    config: crmIntegrations.config,
    lastSyncAt: crmIntegrations.lastSyncAt,
    contactsSynced: crmIntegrations.contactsSynced,
    callsSynced: crmIntegrations.callsSynced,
    createdAt: crmIntegrations.createdAt,
  }).from(crmIntegrations)
    .where(and(eq(crmIntegrations.id, c.req.param('id')), eq(crmIntegrations.tenantId, tenantId)));
  if (!row) throw new NotFound('CRM integration not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = crmSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: crmIntegrations.id }).from(crmIntegrations)
    .where(and(eq(crmIntegrations.name, body.name), eq(crmIntegrations.tenantId, tenantId)));
  if (dup) throw new BadRequest('CRM integration name already exists');
  const [row] = await db.insert(crmIntegrations).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = crmSchema.partial().parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: crmIntegrations.id }).from(crmIntegrations)
      .where(and(eq(crmIntegrations.name, body.name), eq(crmIntegrations.tenantId, tenantId), sql`${crmIntegrations.id} != ${c.req.param('id')}`));
    if (dup) throw new BadRequest('CRM integration name already exists');
  }
  const [row] = await db.update(crmIntegrations).set(body)
    .where(and(eq(crmIntegrations.id, c.req.param('id')), eq(crmIntegrations.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('CRM integration not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(crmIntegrations)
    .where(and(eq(crmIntegrations.id, c.req.param('id')), eq(crmIntegrations.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('CRM integration not found');
  return c.json({ ok: true });
});

// Sync - placeholder
router.post('/:id/sync', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({ id: crmIntegrations.id }).from(crmIntegrations)
    .where(and(eq(crmIntegrations.id, c.req.param('id')), eq(crmIntegrations.tenantId, tenantId)));
  if (!row) throw new NotFound('CRM integration not found');
  return c.json({ ok: true, message: 'Sync queued' }, 202);
});

export default router;
