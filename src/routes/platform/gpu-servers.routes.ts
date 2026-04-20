import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { gpuServers } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';

const router = new Hono();

const gpuServerSchema = z.object({
  provider: z.string().min(1),
  providerId: z.string().nullable().optional(),
  name: z.string().min(1),
  host: z.string().min(1),
  gpuType: z.string().min(1),
  services: z.array(z.string()).nullable().default([]),
  status: z.enum(['online', 'offline', 'maintenance']).default('offline'),
  isDefault: z.boolean().nullable().default(false),
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
  const [dup] = await db.select({ id: gpuServers.id }).from(gpuServers)
    .where(eq(gpuServers.name, body.name));
  if (dup) throw new BadRequest('GPU server name already exists');
  const [row] = await db.insert(gpuServers).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = updateSchema.parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: gpuServers.id }).from(gpuServers)
      .where(sql`${gpuServers.name} = ${body.name} AND ${gpuServers.id} != ${c.req.param('id')}`);
    if (dup) throw new BadRequest('GPU server name already exists');
  }
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
