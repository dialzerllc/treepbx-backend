import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { npaNxx } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';

const router = new Hono();

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    npa: z.string().nullable().optional(),
    nxx: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    lineType: z.string().nullable().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [];
  if (raw.npa) conditions.push(eq(npaNxx.npa, raw.npa));
  if (raw.nxx) conditions.push(eq(npaNxx.nxx, raw.nxx));
  if (raw.city) conditions.push(like(npaNxx.city!, `%${raw.city}%`));
  if (raw.state) conditions.push(eq(npaNxx.state!, raw.state));
  if (raw.lineType) conditions.push(eq(npaNxx.lineType!, raw.lineType));
  if (raw.search) conditions.push(like(npaNxx.city!, `%${raw.search}%`));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(npaNxx).where(where).limit(limit).offset(offset),
    db.select({ total: count() }).from(npaNxx).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.post('/import', async (c) => {
  // Bulk insert NPANXX rows. FE parses CSV and posts JSON to keep this
  // endpoint type-safe; we don't accept multipart here. Conflicts on the
  // (npa, nxx) primary key are skipped silently.
  const body = z.object({
    rows: z.array(z.object({
      npa: z.string().min(3).max(3),
      nxx: z.string().min(3).max(3),
      state: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      county: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
      rateCenter: z.string().nullable().optional(),
      carrier: z.string().nullable().optional(),
      lineType: z.string().nullable().optional(),
    })),
  }).parse(await c.req.json());

  let created = 0; let skipped = 0;
  const batchSize = 500;
  for (let i = 0; i < body.rows.length; i += batchSize) {
    const slice = body.rows.slice(i, i + batchSize);
    const inserted = await db.insert(npaNxx).values(slice).onConflictDoNothing().returning({ npa: npaNxx.npa });
    created += inserted.length;
    skipped += slice.length - inserted.length;
  }
  return c.json({ ok: true, created, skipped });
});

export default router;
