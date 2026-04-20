import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { leads, leadLists } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';
import { optionalUuid, optionalEmail } from '../../lib/zod-helpers';

const router = new Hono();

const leadSchema = z.object({
  leadListId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  phone: z.string().min(1),
  altPhone: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  email: optionalEmail(),
  company: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  customFields: z.union([
    z.record(z.unknown()),
    z.string().transform((s) => { try { return JSON.parse(s); } catch { return {}; } }),
  ]).optional().default({}),
  tags: z.union([
    z.array(z.string()),
    z.string().transform((s) => s ? s.split(',').map((t) => t.trim()).filter(Boolean) : []),
  ]).optional().default([]),
  notes: z.string().nullable().optional(),
  source: z.string().default('manual'),
  priority: z.coerce.number().int().min(1).max(10).default(5),
  maxAttempts: z.coerce.number().int().default(3),
  assignedAgentId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  status: z.string().default('pending'),
});

// Named routes before /:id
router.post('/import', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    leadListId: z.string().uuid(),
    leads: z.array(z.object({
      phone: z.string().min(1),
      firstName: z.string().nullable().optional(),
      lastName: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      company: z.string().nullable().optional(),
      altPhone: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
    })),
  }).parse(await c.req.json());

  // Log first 2 leads to debug CSV parsing
  const { logger } = await import('../../lib/logger');
  if (body.leads.length > 0) {
    logger.info({ sample: body.leads.slice(0, 2), totalLeads: body.leads.length }, '[LeadImport] Received leads sample');
  }

  // Validate leadListId belongs to this tenant
  const [list] = await db.select({ id: leadLists.id }).from(leadLists)
    .where(and(eq(leadLists.id, body.leadListId), eq(leadLists.tenantId, tenantId)));
  if (!list) throw new BadRequest('Lead list not found or does not belong to this tenant');

  let created = 0;
  let skipped = 0;
  const batchSize = 50;
  for (let i = 0; i < body.leads.length; i += batchSize) {
    const batch = body.leads.slice(i, i + batchSize);
    const values = batch.map((l) => ({
      tenantId,
      leadListId: body.leadListId,
      phone: l.phone,
      firstName: l.firstName || null,
      lastName: l.lastName || null,
      email: l.email || null,
      company: l.company || null,
      altPhone: l.altPhone || null,
      timezone: l.timezone || null,
      source: 'csv_import',
      status: 'pending',
    }));
    try {
      const inserted = await db.insert(leads).values(values).onConflictDoNothing().returning({ id: leads.id });
      created += inserted.length;
      skipped += values.length - inserted.length;
    } catch {
      skipped += values.length;
    }
  }

  // Update lead count on the list
  const [{ cnt }] = await db.select({ cnt: count() }).from(leads).where(eq(leads.leadListId, body.leadListId));
  await db.update(leadLists).set({ leadCount: Number(cnt) }).where(eq(leadLists.id, body.leadListId));

  return c.json({ ok: true, created, skipped });
});

router.get('/export', requireRole('tenant_admin', 'supervisor'), async (c) => {
  return c.json({ ok: true, message: 'Export queued', downloadUrl: null }, 202);
});

// Bulk assign to list
router.post('/bulk/assign-list', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()), listId: z.string().uuid() }).parse(await c.req.json());
  await db.update(leads)
    .set({ leadListId: body.listId })
    .where(and(inArray(leads.id, body.ids), eq(leads.tenantId, tenantId)));
  return c.json({ ok: true, updated: body.ids.length });
});

// Bulk delete
router.post('/bulk/delete', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()) }).parse(await c.req.json());
  const deleted = await db.delete(leads)
    .where(and(inArray(leads.id, body.ids), eq(leads.tenantId, tenantId)))
    .returning({ id: leads.id });
  return c.json({ ok: true, deleted: deleted.length });
});

// Bulk toggle DNC
router.post('/bulk/toggle-dnc', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()) }).parse(await c.req.json());
  await db.update(leads)
    .set({ dnc: sql`NOT ${leads.dnc}` })
    .where(and(inArray(leads.id, body.ids), eq(leads.tenantId, tenantId)));
  return c.json({ ok: true, updated: body.ids.length });
});

// Bulk update status
router.post('/bulk/status', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()), status: z.string() }).parse(await c.req.json());
  await db.update(leads)
    .set({ status: body.status })
    .where(and(inArray(leads.id, body.ids), eq(leads.tenantId, tenantId)));
  return c.json({ ok: true, updated: body.ids.length });
});

// Bulk update disposition
router.post('/bulk/disposition', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()), disposition: z.string() }).parse(await c.req.json());
  await db.update(leads)
    .set({ lastDisposition: body.disposition })
    .where(and(inArray(leads.id, body.ids), eq(leads.tenantId, tenantId)));
  return c.json({ ok: true, updated: body.ids.length });
});

// Bulk assign agent
router.post('/bulk/assign-agent', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ ids: z.array(z.string().uuid()), agentId: z.string().uuid() }).parse(await c.req.json());
  await db.update(leads)
    .set({ assignedAgentId: body.agentId })
    .where(and(inArray(leads.id, body.ids), eq(leads.tenantId, tenantId)));
  return c.json({ ok: true, updated: body.ids.length });
});

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    leadListId: optionalUuid(),
    status: z.string().nullable().optional(),
    dnc: z.coerce.boolean().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(leads.tenantId, tenantId)];
  if (raw.search) conditions.push(like(leads.phone, `%${raw.search}%`));
  if (raw.leadListId) {
    conditions.push(eq(leads.leadListId, raw.leadListId));
  } else {
    // Default: show only leads from the default list
    const [defaultList] = await db.select({ id: leadLists.id }).from(leadLists)
      .where(and(eq(leadLists.tenantId, tenantId), eq(leadLists.isDefault, true)));
    if (defaultList) conditions.push(eq(leads.leadListId, defaultList.id));
  }
  if (raw.status) conditions.push(eq(leads.status, raw.status));
  if (raw.dnc !== undefined) conditions.push(eq(leads.dnc, raw.dnc));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      lead: leads,
      listName: leadLists.name,
    }).from(leads)
      .leftJoin(leadLists, eq(leads.leadListId, leadLists.id))
      .where(where).orderBy(desc(leads.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(leads).where(where),
  ]);

  const data = rows.map((r) => ({ ...r.lead, listName: r.listName ?? null }));
  return c.json(paginatedResponse(data, Number(total), raw));
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(leads)
    .where(and(eq(leads.id, c.req.param('id')), eq(leads.tenantId, tenantId)));
  if (!row) throw new NotFound('Lead not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = leadSchema.parse(await c.req.json());

  // Duplicate check by phone within same tenant
  const [existing] = await db.select({ id: leads.id, phone: leads.phone, leadListId: leads.leadListId })
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.phone, body.phone)))
    .limit(1);
  if (existing) {
    throw new BadRequest('Lead phone number already exists');
  }

  // Auto-assign default list if none provided
  if (!body.leadListId) {
    let [defaultList] = await db.select({ id: leadLists.id }).from(leadLists)
      .where(and(eq(leadLists.tenantId, tenantId), eq(leadLists.name, 'Default')))
      .limit(1);
    if (!defaultList) {
      [defaultList] = await db.insert(leadLists)
        .values({ tenantId, name: 'Default', description: 'Auto-created default list', source: 'system' })
        .returning({ id: leadLists.id });
    }
    body.leadListId = defaultList.id;
  }

  const [row] = await db.insert(leads).values({ ...body as any, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = leadSchema.partial().omit({ leadListId: true }).passthrough().parse(await c.req.json());
  const [row] = await db.update(leads).set(body)
    .where(and(eq(leads.id, c.req.param('id')), eq(leads.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Lead not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(leads)
    .where(and(eq(leads.id, c.req.param('id')), eq(leads.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Lead not found');
  return c.json({ ok: true });
});


export default router;
