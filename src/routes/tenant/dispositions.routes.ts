import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, or, isNull, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { dispositions } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const dispositionSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  category: z.string().min(1),
  autoDnc: z.boolean().default(false),
  isCompleted: z.boolean().default(false),
  requiresNote: z.boolean().default(false),
  requiresCallback: z.boolean().default(false),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    category: z.string().optional(),
    enabled: z.coerce.boolean().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  // Include system dispositions (tenantId IS NULL) and tenant's own
  const conditions: any[] = [or(eq(dispositions.tenantId, tenantId), isNull(dispositions.tenantId))!];
  if (raw.search) conditions.push(like(dispositions.label, `%${raw.search}%`));
  if (raw.category) conditions.push(eq(dispositions.category, raw.category));
  if (raw.enabled !== undefined) conditions.push(eq(dispositions.enabled, raw.enabled));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(dispositions).where(where).orderBy(dispositions.sortOrder, desc(dispositions.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(dispositions).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(dispositions)
    .where(and(eq(dispositions.id, c.req.param('id')), or(eq(dispositions.tenantId, tenantId), isNull(dispositions.tenantId))!));
  if (!row) throw new NotFound('Disposition not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = dispositionSchema.parse(await c.req.json());
  const [row] = await db.insert(dispositions).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const id = c.req.param('id');

  const [existing] = await db.select().from(dispositions)
    .where(and(eq(dispositions.id, id), or(eq(dispositions.tenantId, tenantId), isNull(dispositions.tenantId))!));
  if (!existing) throw new NotFound('Disposition not found');

  // System dispositions: only toggle enabled
  if (existing.isSystem) {
    const body = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    // For system dispositions, we upsert a tenant-level override or just update if already tenant-owned
    if (!existing.tenantId) {
      // Create a tenant copy with the same data but enabled overridden
      const [row] = await db.insert(dispositions).values({
        ...existing,
        id: undefined as any,
        tenantId,
        enabled: body.enabled,
        isSystem: false,
      }).returning();
      return c.json(row);
    }
    const [row] = await db.update(dispositions).set({ enabled: body.enabled })
      .where(eq(dispositions.id, id)).returning();
    return c.json(row);
  }

  if (!existing.tenantId || existing.tenantId !== tenantId) {
    throw new BadRequest('Cannot modify system disposition');
  }

  const body = dispositionSchema.partial().parse(await c.req.json());
  const [row] = await db.update(dispositions).set(body)
    .where(eq(dispositions.id, id)).returning();
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const id = c.req.param('id');

  const [existing] = await db.select().from(dispositions)
    .where(and(eq(dispositions.id, id), eq(dispositions.tenantId, tenantId)));
  if (!existing) throw new NotFound('Disposition not found or cannot be deleted');
  if (existing.isSystem) throw new BadRequest('System dispositions cannot be deleted');

  await db.delete(dispositions).where(eq(dispositions.id, id));
  return c.json({ ok: true });
});

export default router;
