import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { leadLists } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const leadListSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.string().default('manual'),
  status: z.enum(['active', 'archived', 'processing']).default('active'),
  dialMode: z.string().nullable().optional(),
  maxAttempts: z.number().int().positive().default(3),
  retryDelayMinutes: z.number().int().positive().default(60),
  priority: z.number().int().min(1).max(10).default(5),
  timezone: z.string().nullable().optional(),
  campaignId: z.string().uuid().nullable().optional(),
});

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    status: z.string().optional(),
    campaignId: z.string().uuid().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(leadLists.tenantId, tenantId)];
  if (raw.search) conditions.push(like(leadLists.name, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(leadLists.status, raw.status));
  if (raw.campaignId) conditions.push(eq(leadLists.campaignId, raw.campaignId));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(leadLists).where(where).orderBy(desc(leadLists.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(leadLists).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(leadLists)
    .where(and(eq(leadLists.id, c.req.param('id')), eq(leadLists.tenantId, tenantId)));
  if (!row) throw new NotFound('Lead list not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = leadListSchema.parse(await c.req.json());
  const [row] = await db.insert(leadLists).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = leadListSchema.partial().parse(await c.req.json());
  const [row] = await db.update(leadLists).set(body)
    .where(and(eq(leadLists.id, c.req.param('id')), eq(leadLists.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Lead list not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(leadLists)
    .where(and(eq(leadLists.id, c.req.param('id')), eq(leadLists.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Lead list not found');
  return c.json({ ok: true });
});

export default router;
