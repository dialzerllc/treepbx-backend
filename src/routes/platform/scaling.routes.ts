import { Hono } from 'hono';
import { z } from 'zod';
import { eq, like, desc, count, and } from 'drizzle-orm';
import { db } from '../../db/client';
import { scalingRules, scalingEvents, hetznerServers } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const ruleSchema = z.object({
  name: z.string().min(1),
  serviceType: z.string().min(1),
  serverType: z.string().optional(),
  location: z.string().optional(),
  metric: z.string().min(1),
  thresholdUp: z.string(),
  thresholdDown: z.string(),
  minInstances: z.number().int().min(0).default(1),
  maxInstances: z.number().int().positive().default(10),
  cooldownSeconds: z.number().int().positive().default(300),
  callsPerInstance: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = raw.search ? like(scalingRules.name, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(scalingRules).where(where).orderBy(desc(scalingRules.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(scalingRules).where(where),
  ]);
  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Named routes must be before /:id to avoid route shadowing
// Scaling events history
router.get('/events', async (c) => {
  const raw = paginationSchema.extend({
    serviceType: z.string().optional(),
    status: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [];
  if (raw.serviceType) conditions.push(eq(scalingEvents.serviceType, raw.serviceType));
  if (raw.status) conditions.push(eq(scalingEvents.status, raw.status));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(scalingEvents).where(where).orderBy(desc(scalingEvents.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(scalingEvents).where(where),
  ]);
  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Hetzner servers infra dashboard
router.get('/hetzner', async (c) => {
  const raw = paginationSchema.extend({
    role: z.string().optional(),
    status: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [];
  if (raw.role) conditions.push(eq(hetznerServers.role, raw.role));
  if (raw.status) conditions.push(eq(hetznerServers.status, raw.status));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(hetznerServers).where(where).orderBy(desc(hetznerServers.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(hetznerServers).where(where),
  ]);
  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(scalingRules).where(eq(scalingRules.id, c.req.param('id')));
  if (!row) throw new NotFound('Scaling rule not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = ruleSchema.parse(await c.req.json());
  const [row] = await db.insert(scalingRules).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = ruleSchema.partial().parse(await c.req.json());
  const [row] = await db.update(scalingRules).set(body).where(eq(scalingRules.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Scaling rule not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(scalingRules).where(eq(scalingRules.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Scaling rule not found');
  return c.json({ ok: true });
});

export default router;
