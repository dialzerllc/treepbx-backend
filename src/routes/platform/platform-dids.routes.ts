import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { platformDids, platformDidGroups } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const didSchema = z.object({
  number: z.string().min(1),
  provider: z.string().min(1),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().default('US'),
  didType: z.enum(['local', 'tollfree', 'mobile']).default('local'),
  monthlyCost: z.string().default('0'),
  status: z.enum(['available', 'assigned', 'reserved', 'porting']).default('available'),
  tenantId: z.string().uuid().nullable().optional(),
  groupId: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
});

const groupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean().default(false),
  visibleToAll: z.boolean().default(true),
  assignedTenantId: z.string().uuid().nullable().optional(),
});

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    status: z.string().optional(),
    groupId: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [];
  if (raw.search) conditions.push(like(platformDids.number, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(platformDids.status, raw.status));
  if (raw.groupId) conditions.push(eq(platformDids.groupId, raw.groupId));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(platformDids).where(where).orderBy(desc(platformDids.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(platformDids).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// DID Groups — must be before /:id to avoid route shadowing
router.get('/groups', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = raw.search ? like(platformDidGroups.name, `%${raw.search}%`) : undefined;
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(platformDidGroups).where(where).orderBy(desc(platformDidGroups.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(platformDidGroups).where(where),
  ]);
  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.post('/groups', async (c) => {
  const body = groupSchema.parse(await c.req.json());
  const [row] = await db.insert(platformDidGroups).values(body).returning();
  return c.json(row, 201);
});

router.put('/groups/:id', async (c) => {
  const body = groupSchema.partial().parse(await c.req.json());
  const [row] = await db.update(platformDidGroups).set(body).where(eq(platformDidGroups.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('DID group not found');
  return c.json(row);
});

router.delete('/groups/:id', async (c) => {
  const [row] = await db.delete(platformDidGroups).where(eq(platformDidGroups.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('DID group not found');
  return c.json({ ok: true });
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(platformDids).where(eq(platformDids.id, c.req.param('id')));
  if (!row) throw new NotFound('DID not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = didSchema.parse(await c.req.json());
  const [row] = await db.insert(platformDids).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = didSchema.partial().parse(await c.req.json());
  const [row] = await db.update(platformDids).set(body).where(eq(platformDids.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('DID not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(platformDids).where(eq(platformDids.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('DID not found');
  return c.json({ ok: true });
});

export default router;
