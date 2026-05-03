import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count, and, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { rateGroups, rateCards } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';

const router = new Hono();

const rateGroupSchema = z.object({
  name: z.string().min(1),
  inboundCarrierId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  outboundCarrierId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  currency: z.string().default('USD'),
  inboundBillingIncrement: z.string().default('1/1'),
  outboundBillingIncrement: z.string().default('6/6'),
  featureBillingIncrement: z.string().default('6/6'),
  recordingRate: z.union([z.string(), z.number()]).transform(String).default('0.002'),
  voicebotRate: z.union([z.string(), z.number()]).transform(String).default('0.015'),
  byocRate: z.union([z.string(), z.number()]).transform(String).default('0.008'),
  storageRate: z.union([z.string(), z.number()]).transform(String).default('0.10'),
  effectiveDate: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
}).passthrough();

function parseRatePayload(raw: any, groupId: string) {
  return [
    ...(raw.inboundRates ?? []).map((r: any) => ({ rateGroupId: groupId, country: r.country, countryCode: r.countryCode || r.code, direction: 'inbound' as const, billingIncrement: r.billingIncrement || '6/6', ratePerMinute: String(r.ratePerMinute ?? r.rate ?? 0) })),
    ...(raw.outboundRates ?? []).map((r: any) => ({ rateGroupId: groupId, country: r.country, countryCode: r.countryCode || r.code, direction: 'outbound' as const, billingIncrement: r.billingIncrement || '6/6', ratePerMinute: String(r.ratePerMinute ?? r.rate ?? 0) })),
  ];
}

function formatGroupWithRates(g: any, cards: any[]) {
  return {
    ...g,
    recordingRate: Number(g.recordingRate ?? 0),
    voicebotRate: Number(g.voicebotRate ?? 0),
    byocRate: Number(g.byocRate ?? 0),
    storageRate: Number(g.storageRate ?? 0),
    inboundRates: cards.filter((c) => c.direction === 'inbound').map((c) => ({
      country: c.country, code: c.countryCode, billingIncrement: c.billingIncrement || '6/6', rate: Number(c.ratePerMinute),
    })),
    outboundRates: cards.filter((c) => c.direction === 'outbound').map((c) => ({
      country: c.country, code: c.countryCode, billingIncrement: c.billingIncrement || '6/6', rate: Number(c.ratePerMinute),
    })),
  };
}

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

  // Attach per-country rates to each group
  const groupIds = rows.map((r) => r.id);
  const allCards = groupIds.length > 0
    ? await db.select().from(rateCards).where(inArray(rateCards.rateGroupId, groupIds))
    : [];

  const data = rows.map((g) => {
    const cards = allCards.filter((c) => c.rateGroupId === g.id);
    return {
      ...g,
      recordingRate: Number(g.recordingRate ?? 0),
      voicebotRate: Number(g.voicebotRate ?? 0),
      byocRate: Number(g.byocRate ?? 0),
      storageRate: Number(g.storageRate ?? 0),
      inboundRates: cards.filter((c) => c.direction === 'inbound').map((c) => ({
        country: c.country, code: c.countryCode, billingIncrement: c.billingIncrement || '6/6', rate: Number(c.ratePerMinute),
      })),
      outboundRates: cards.filter((c) => c.direction === 'outbound').map((c) => ({
        country: c.country, code: c.countryCode, billingIncrement: c.billingIncrement || '6/6', rate: Number(c.ratePerMinute),
      })),
    };
  });

  return c.json(paginatedResponse(data, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [group] = await db.select().from(rateGroups).where(eq(rateGroups.id, c.req.param('id')));
  if (!group) throw new NotFound('Rate group not found');
  const cards = await db.select().from(rateCards).where(eq(rateCards.rateGroupId, group.id));
  return c.json({
    ...group,
    recordingRate: Number(group.recordingRate ?? 0),
    voicebotRate: Number(group.voicebotRate ?? 0),
    byocRate: Number(group.byocRate ?? 0),
    storageRate: Number(group.storageRate ?? 0),
    inboundRates: cards.filter((c) => c.direction === 'inbound').map((c) => ({
      country: c.country, code: c.countryCode, rate: Number(c.ratePerMinute),
    })),
    outboundRates: cards.filter((c) => c.direction === 'outbound').map((c) => ({
      country: c.country, code: c.countryCode, rate: Number(c.ratePerMinute),
    })),
  });
});

router.post('/', async (c) => {
  const raw = await c.req.json();
  const body = rateGroupSchema.parse(raw);
  const [dup] = await db.select({ id: rateGroups.id }).from(rateGroups)
    .where(eq(rateGroups.name, body.name));
  if (dup) throw new BadRequest('Rate group name already exists');
  const { inboundRates: _ir, outboundRates: _or, newCountry: _nc, newCode: _nco, newFlag: _nf, newRate: _nr, newBillingIncrement: _nb, newMonthlyDID: _nm, ...insertFields } = body as any;
  const [row] = await db.insert(rateGroups).values(insertFields).returning();

  const inbound: any[] = Array.isArray(raw.inboundRates) ? raw.inboundRates : [];
  const outbound: any[] = Array.isArray(raw.outboundRates) ? raw.outboundRates : [];
  const rateRows = [
    ...inbound.map((r: any) => ({ rateGroupId: row.id, country: String(r.country), countryCode: String(r.countryCode || r.code), direction: 'inbound' as const, ratePerMinute: String(r.ratePerMinute ?? r.rate ?? 0) })),
    ...outbound.map((r: any) => ({ rateGroupId: row.id, country: String(r.country), countryCode: String(r.countryCode || r.code), direction: 'outbound' as const, ratePerMinute: String(r.ratePerMinute ?? r.rate ?? 0) })),
  ];
  if (rateRows.length > 0) {
    await db.insert(rateCards).values(rateRows);
  }

  const cards = await db.select().from(rateCards).where(eq(rateCards.rateGroupId, row.id));
  return c.json(formatGroupWithRates(row, cards), 201);
});

router.put('/:id', async (c) => {
  const groupId = c.req.param('id');
  const raw = await c.req.json();
  const body = rateGroupSchema.partial().parse(raw);
  if (body.name) {
    const [dup] = await db.select({ id: rateGroups.id }).from(rateGroups)
      .where(sql`${rateGroups.name} = ${body.name} AND ${rateGroups.id} != ${groupId}`);
    if (dup) throw new BadRequest('Rate group name already exists');
  }
  // Strip non-DB fields before updating
  const { inboundRates, outboundRates, newCountry, newCode, newFlag, newRate, newBillingIncrement, newMonthlyDID, ...dbFields } = body as any;
  const [row] = await db.update(rateGroups).set(dbFields).where(eq(rateGroups.id, groupId)).returning();
  if (!row) throw new NotFound('Rate group not found');

  const inbound: any[] = Array.isArray(raw.inboundRates) ? raw.inboundRates : [];
  const outbound: any[] = Array.isArray(raw.outboundRates) ? raw.outboundRates : [];

  // Delete existing and re-insert
  await db.delete(rateCards).where(eq(rateCards.rateGroupId, groupId));
  const rateRows = [
    ...inbound.map((r: any) => ({ rateGroupId: groupId, country: String(r.country), countryCode: String(r.countryCode || r.code), direction: 'inbound' as const, ratePerMinute: String(r.ratePerMinute ?? r.rate ?? 0) })),
    ...outbound.map((r: any) => ({ rateGroupId: groupId, country: String(r.country), countryCode: String(r.countryCode || r.code), direction: 'outbound' as const, ratePerMinute: String(r.ratePerMinute ?? r.rate ?? 0) })),
  ];
  if (rateRows.length > 0) {
    await db.insert(rateCards).values(rateRows);
  }

  const cards = await db.select().from(rateCards).where(eq(rateCards.rateGroupId, groupId));
  return c.json(formatGroupWithRates(row, cards));
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

// Bulk import rate cards into an existing group. FE parses CSV → posts JSON.
// Same conflict-handling philosophy as the leads import: silently skip dupes
// (same country/code/direction in the group already exists).
router.post('/:id/rate-cards/bulk', async (c) => {
  const groupId = c.req.param('id');
  const body = z.object({ rows: z.array(rateCardSchema) }).parse(await c.req.json());
  const [group] = await db.select({ id: rateGroups.id }).from(rateGroups).where(eq(rateGroups.id, groupId));
  if (!group) throw new NotFound('Rate group not found');
  const values = body.rows.map((r) => ({ ...r, rateGroupId: groupId }));
  let created = 0;
  const batchSize = 500;
  for (let i = 0; i < values.length; i += batchSize) {
    const slice = values.slice(i, i + batchSize);
    const inserted = await db.insert(rateCards).values(slice).returning({ id: rateCards.id });
    created += inserted.length;
  }
  return c.json({ ok: true, created });
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
