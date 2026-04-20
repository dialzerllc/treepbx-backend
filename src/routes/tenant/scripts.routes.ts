import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { scripts } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const scriptSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  steps: z.array(z.record(z.unknown())).optional(),
});

// List scripts
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = eq(scripts.tenantId, tenantId);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(scripts).where(where).orderBy(desc(scripts.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(scripts).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Get single script
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(scripts)
    .where(and(eq(scripts.id, c.req.param('id')), eq(scripts.tenantId, tenantId)));
  if (!row) throw new NotFound('Script not found');
  return c.json(row);
});

// Create script
router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = scriptSchema.parse(await c.req.json());
  const [row] = await db.insert(scripts).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

// Update script
router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = scriptSchema.partial().parse(await c.req.json());
  const [row] = await db.update(scripts).set({ ...body, updatedAt: new Date() })
    .where(and(eq(scripts.id, c.req.param('id')), eq(scripts.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Script not found');
  return c.json(row);
});

// Delete script
router.delete('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(scripts)
    .where(and(eq(scripts.id, c.req.param('id')), eq(scripts.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Script not found');
  return c.json({ ok: true });
});

export default router;
