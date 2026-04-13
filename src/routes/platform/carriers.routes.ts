import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { carriers } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const carrierSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().default(5060),
  transport: z.enum(['UDP', 'TCP', 'TLS']).default('UDP'),
  direction: z.enum(['inbound', 'outbound', 'both']).default('both'),
  maxChannels: z.number().int().positive().default(100),
  priority: z.number().int().min(1).default(1),
  status: z.enum(['active', 'inactive']).default('active'),
});

const updateCarrierSchema = carrierSchema.partial();

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = raw.search ? like(carriers.name, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(carriers).where(where).orderBy(desc(carriers.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(carriers).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(carriers).where(eq(carriers.id, c.req.param('id')));
  if (!row) throw new NotFound('Carrier not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = carrierSchema.parse(await c.req.json());
  const [row] = await db.insert(carriers).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = updateCarrierSchema.parse(await c.req.json());
  const [row] = await db.update(carriers).set(body).where(eq(carriers.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Carrier not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(carriers).where(eq(carriers.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Carrier not found');
  return c.json({ ok: true });
});

export default router;
