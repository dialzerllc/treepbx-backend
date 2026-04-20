import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { gpuScalingRules } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const ruleSchema = z.object({
  name: z.string().min(1),
  metric: z.string().min(1),
  thresholdUp: z.string(),
  thresholdDown: z.string(),
  minInstances: z.coerce.number().int().default(1),
  maxInstances: z.coerce.number().int().default(4),
  gpuType: z.string().min(1),
  provider: z.string().default('runpod'),
  enabled: z.boolean().nullable().default(true),
});

const updateSchema = ruleSchema.partial();

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = raw.search ? like(gpuScalingRules.name, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(gpuScalingRules).where(where).orderBy(desc(gpuScalingRules.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(gpuScalingRules).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(gpuScalingRules).where(eq(gpuScalingRules.id, c.req.param('id')));
  if (!row) throw new NotFound('GPU scaling rule not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = ruleSchema.parse(await c.req.json());
  const [row] = await db.insert(gpuScalingRules).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = updateSchema.parse(await c.req.json());
  const [row] = await db.update(gpuScalingRules).set(body).where(eq(gpuScalingRules.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('GPU scaling rule not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(gpuScalingRules).where(eq(gpuScalingRules.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('GPU scaling rule not found');
  return c.json({ ok: true });
});

export default router;
