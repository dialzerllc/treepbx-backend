import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count, and } from 'drizzle-orm';
import { db } from '../../db/client';
import { rateGroups, rateCards } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const rateGroupSchema = z.object({
  name: z.string().min(1),
  inboundCarrierId: z.string().uuid().nullable().optional(),
  outboundCarrierId: z.string().uuid().nullable().optional(),
  currency: z.string().default('USD'),
  inboundBillingIncrement: z.string().default('1/1'),
  outboundBillingIncrement: z.string().default('6/6'),
  featureBillingIncrement: z.string().default('6/6'),
  recordingRate: z.string().default('0.002'),
  voicebotRate: z.string().default('0.015'),
  byocRate: z.string().default('0.008'),
  storageRate: z.string().default('0.10'),
  effectiveDate: z.string(),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
});

const rateCardSchema = z.object({
  country: z.string().min(1),
  countryCode: z.string().min(1),
  direction: z.enum(['inbound', 'outbound']),
  ratePerMinute: z.string(),
});

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = raw.search ? like(rateGroups.name, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(rateGroups).where(where).orderBy(desc(rateGroups.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(rateGroups).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [group] = await db.select().from(rateGroups).where(eq(rateGroups.id, c.req.param('id')));
  if (!group) throw new NotFound('Rate group not found');
  const cards = await db.select().from(rateCards).where(eq(rateCards.rateGroupId, group.id));
  return c.json({ ...group, rateCards: cards });
});

router.post('/', async (c) => {
  const body = rateGroupSchema.parse(await c.req.json());
  const [row] = await db.insert(rateGroups).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = rateGroupSchema.partial().parse(await c.req.json());
  const [row] = await db.update(rateGroups).set(body).where(eq(rateGroups.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Rate group not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(rateGroups).where(eq(rateGroups.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Rate group not found');
  return c.json({ ok: true });
});

// Nested rate cards
router.get('/:id/rate-cards', async (c) => {
  const cards = await db.select().from(rateCards).where(eq(rateCards.rateGroupId, c.req.param('id')));
  return c.json(cards);
});

router.post('/:id/rate-cards', async (c) => {
  const body = rateCardSchema.parse(await c.req.json());
  const [row] = await db.insert(rateCards).values({ ...body, rateGroupId: c.req.param('id') }).returning();
  return c.json(row, 201);
});

router.put('/:id/rate-cards/:cardId', async (c) => {
  const body = rateCardSchema.partial().parse(await c.req.json());
  const [row] = await db.update(rateCards).set(body)
    .where(and(eq(rateCards.id, c.req.param('cardId')), eq(rateCards.rateGroupId, c.req.param('id')))).returning();
  if (!row) throw new NotFound('Rate card not found');
  return c.json(row);
});

router.delete('/:id/rate-cards/:cardId', async (c) => {
  const [row] = await db.delete(rateCards)
    .where(and(eq(rateCards.id, c.req.param('cardId')), eq(rateCards.rateGroupId, c.req.param('id')))).returning();
  if (!row) throw new NotFound('Rate card not found');
  return c.json({ ok: true });
});

export default router;
