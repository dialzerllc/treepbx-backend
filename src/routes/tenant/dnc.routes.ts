import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { dncEntries } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const dncSchema = z.object({
  phone: z.string().min(1),
  reason: z.string().nullable().optional(),
  source: z.string().default('manual'),
});

// Named routes before /:id
router.post('/import', requireRole('tenant_admin', 'supervisor'), async (c) => {
  return c.json({ ok: true, message: 'DNC import queued' }, 202);
});

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    source: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(dncEntries.tenantId, tenantId)];
  if (raw.search) conditions.push(like(dncEntries.phone, `%${raw.search}%`));
  if (raw.source) conditions.push(eq(dncEntries.source, raw.source));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(dncEntries).where(where).orderBy(desc(dncEntries.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(dncEntries).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(dncEntries)
    .where(and(eq(dncEntries.id, c.req.param('id')), eq(dncEntries.tenantId, tenantId)));
  if (!row) throw new NotFound('DNC entry not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const body = dncSchema.parse(await c.req.json());

  // Check for duplicate
  const [existing] = await db.select({ id: dncEntries.id }).from(dncEntries)
    .where(and(eq(dncEntries.tenantId, tenantId), eq(dncEntries.phone, body.phone)));
  if (existing) throw new BadRequest('Phone number already in DNC list');

  const [row] = await db.insert(dncEntries).values({ ...body, tenantId, addedBy: userId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = dncSchema.partial().omit({ phone: true }).passthrough().parse(await c.req.json());
  const [row] = await db.update(dncEntries).set(body)
    .where(and(eq(dncEntries.id, c.req.param('id')), eq(dncEntries.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('DNC entry not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(dncEntries)
    .where(and(eq(dncEntries.id, c.req.param('id')), eq(dncEntries.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('DNC entry not found');
  return c.json({ ok: true });
});

export default router;
