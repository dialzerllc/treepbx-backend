import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count, and, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { plans } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';

const router = new Hono();

// price_monthly/price_yearly/included_credit are numeric(10,2) in postgres
// (max 99999999.99). Validate the string parses to a number in range so we
// 400 instead of letting postgres throw "numeric field overflow".
const moneyString = z.string().refine((v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 99999999.99;
}, { message: 'Must be a number between 0 and 99999999.99' });

const planSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  priceMonthly: moneyString,
  priceYearly: moneyString,
  maxAgents: z.coerce.number().int().min(1).max(100000).default(1),
  maxConcurrentCalls: z.coerce.number().int().min(1).max(100000).default(1),
  maxDids: z.coerce.number().int().min(1).max(100000).default(1),
  rateGroupId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  includedCredit: moneyString.default('0'),
  features: z.array(z.unknown()).default([]),
  popular: z.boolean().nullable().default(false),
  active: z.boolean().nullable().default(true),
});

const updatePlanSchema = planSchema.partial();

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = raw.search ? like(plans.name, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(plans).where(where).orderBy(desc(plans.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(plans).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(plans).where(eq(plans.id, c.req.param('id')));
  if (!row) throw new NotFound('Plan not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = planSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: plans.id }).from(plans)
    .where(eq(plans.name, body.name));
  if (dup) throw new BadRequest('Plan name already exists');
  const [row] = await db.insert(plans).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = updatePlanSchema.parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: plans.id }).from(plans)
      .where(sql`${plans.name} = ${body.name} AND ${plans.id} != ${c.req.param('id')}`);
    if (dup) throw new BadRequest('Plan name already exists');
  }
  const [row] = await db.update(plans).set(body).where(eq(plans.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Plan not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(plans).where(eq(plans.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Plan not found');
  return c.json({ ok: true });
});

export default router;
