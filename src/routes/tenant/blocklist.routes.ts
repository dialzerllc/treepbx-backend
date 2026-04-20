import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { blocklist } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const blocklistSchema = z.object({
  phone: z.string().min(1),
  direction: z.string().default('both'),
  reason: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional().transform((v) => v ? new Date(v) : null),
});

// List blocklist entries
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(blocklist.tenantId, tenantId)];
  if (raw.search) conditions.push(like(blocklist.phone, `%${raw.search}%`));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(blocklist).where(where).orderBy(desc(blocklist.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(blocklist).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Create blocklist entry
router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = blocklistSchema.parse(await c.req.json());
  const [row] = await db.insert(blocklist).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

// Delete blocklist entry
router.delete('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(blocklist)
    .where(and(eq(blocklist.id, c.req.param('id')), eq(blocklist.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Blocklist entry not found');
  return c.json({ ok: true });
});

export default router;
