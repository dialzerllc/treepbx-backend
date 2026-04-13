import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { leads } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const leadSchema = z.object({
  leadListId: z.string().uuid(),
  phone: z.string().min(1),
  altPhone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  company: z.string().optional(),
  timezone: z.string().optional(),
  customFields: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  source: z.string().default('manual'),
  priority: z.number().int().min(1).max(10).default(5),
  maxAttempts: z.number().int().positive().default(3),
  assignedAgentId: z.string().uuid().nullable().optional(),
  status: z.string().default('pending'),
});

// Named routes before /:id
router.post('/import', requireRole('tenant_admin', 'supervisor'), async (c) => {
  return c.json({ ok: true, message: 'Import queued' }, 202);
});

router.get('/export', requireRole('tenant_admin', 'supervisor'), async (c) => {
  return c.json({ ok: true, message: 'Export queued', downloadUrl: null }, 202);
});

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    leadListId: z.string().uuid().optional(),
    status: z.string().optional(),
    dnc: z.coerce.boolean().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(leads.tenantId, tenantId)];
  if (raw.search) conditions.push(like(leads.phone, `%${raw.search}%`));
  if (raw.leadListId) conditions.push(eq(leads.leadListId, raw.leadListId));
  if (raw.status) conditions.push(eq(leads.status, raw.status));
  if (raw.dnc !== undefined) conditions.push(eq(leads.dnc, raw.dnc));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(leads).where(where).orderBy(desc(leads.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(leads).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
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
  const [row] = await db.insert(leads).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = leadSchema.partial().omit({ leadListId: true }).parse(await c.req.json());
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
