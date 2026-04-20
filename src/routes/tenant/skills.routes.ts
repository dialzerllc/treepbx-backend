import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { skills } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(skills.tenantId, tenantId)];
  if (raw.search) conditions.push(like(skills.name, `%${raw.search}%`));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(skills).where(where).orderBy(desc(skills.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(skills).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(skills)
    .where(and(eq(skills.id, c.req.param('id')), eq(skills.tenantId, tenantId)));
  if (!row) throw new NotFound('Skill not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = skillSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: skills.id }).from(skills)
    .where(and(eq(skills.name, body.name), eq(skills.tenantId, tenantId)));
  if (dup) throw new BadRequest('Skill name already exists');
  const [row] = await db.insert(skills).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = skillSchema.partial().parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: skills.id }).from(skills)
      .where(and(eq(skills.name, body.name), eq(skills.tenantId, tenantId), sql`${skills.id} != ${c.req.param('id')}`));
    if (dup) throw new BadRequest('Skill name already exists');
  }
  const [row] = await db.update(skills).set(body)
    .where(and(eq(skills.id, c.req.param('id')), eq(skills.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Skill not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(skills)
    .where(and(eq(skills.id, c.req.param('id')), eq(skills.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Skill not found');
  return c.json({ ok: true });
});

export default router;
