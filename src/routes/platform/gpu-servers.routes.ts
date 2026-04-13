import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { gpuServers } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const gpuServerSchema = z.object({
  provider: z.string().min(1),
  providerId: z.string().optional(),
  name: z.string().min(1),
  host: z.string().min(1),
  gpuType: z.string().min(1),
  services: z.array(z.string()).default([]),
  status: z.enum(['online', 'offline', 'maintenance']).default('offline'),
  isDefault: z.boolean().default(false),
});

const updateSchema = gpuServerSchema.partial();

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = raw.search ? like(gpuServers.name, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(gpuServers).where(where).orderBy(desc(gpuServers.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(gpuServers).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(gpuServers).where(eq(gpuServers.id, c.req.param('id')));
  if (!row) throw new NotFound('GPU server not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = gpuServerSchema.parse(await c.req.json());
  const [row] = await db.insert(gpuServers).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = updateSchema.parse(await c.req.json());
  const [row] = await db.update(gpuServers).set(body).where(eq(gpuServers.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('GPU server not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(gpuServers).where(eq(gpuServers.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('GPU server not found');
  return c.json({ ok: true });
});

export default router;
