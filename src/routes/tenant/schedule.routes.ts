import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, gte, lte, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { scheduleEvents, followUpTodos } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const eventSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  startTime: z.string().transform((s) => new Date(s).toISOString()),
  endTime: z.string().transform((s) => new Date(s).toISOString()),
  leadId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  leadName: z.string().nullable().optional(),
  leadPhone: z.string().nullable().optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  campaignId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  status: z.string().default('upcoming'),
});

const todoSchema = z.object({
  leadId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  leadName: z.string().nullable().optional(),
  leadPhone: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  dueDate: z.string().transform((s) => new Date(s).toISOString()),
});

// List schedule events for current user
router.get('/events', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const raw = paginationSchema.extend({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [
    eq(scheduleEvents.tenantId, tenantId),
    eq(scheduleEvents.userId, userId),
  ];
  if (raw.from) conditions.push(gte(scheduleEvents.startTime, new Date(raw.from)));
  if (raw.to) conditions.push(lte(scheduleEvents.startTime, new Date(raw.to)));
  if (raw.type) conditions.push(eq(scheduleEvents.type, raw.type));
  if (raw.status) conditions.push(eq(scheduleEvents.status, raw.status));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(scheduleEvents).where(where).orderBy(scheduleEvents.startTime).limit(limit).offset(offset),
    db.select({ total: count() }).from(scheduleEvents).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Create event
router.post('/events', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const body = eventSchema.parse(await c.req.json());
  const [row] = await db.insert(scheduleEvents).values({
    ...body,
    tenantId,
    userId,
    startTime: new Date(body.startTime),
    endTime: new Date(body.endTime),
  }).returning();
  return c.json(row, 201);
});

// Update event
router.put('/events/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const body = eventSchema.partial().parse(await c.req.json());
  const update: any = { ...body };
  if (body.startTime) update.startTime = new Date(body.startTime);
  if (body.endTime) update.endTime = new Date(body.endTime);

  const [row] = await db.update(scheduleEvents).set(update)
    .where(and(
      eq(scheduleEvents.id, c.req.param('id')),
      eq(scheduleEvents.tenantId, tenantId),
      eq(scheduleEvents.userId, userId),
    ))
    .returning();
  if (!row) throw new NotFound('Event not found');
  return c.json(row);
});

// Delete event
router.delete('/events/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const [row] = await db.delete(scheduleEvents)
    .where(and(
      eq(scheduleEvents.id, c.req.param('id')),
      eq(scheduleEvents.tenantId, tenantId),
      eq(scheduleEvents.userId, userId),
    ))
    .returning();
  if (!row) throw new NotFound('Event not found');
  return c.json({ ok: true });
});

// List todos
router.get('/todos', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const raw = paginationSchema.extend({
    completed: z.coerce.boolean().optional(),
    priority: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [
    eq(followUpTodos.tenantId, tenantId),
    eq(followUpTodos.agentId, userId),
  ];
  if (raw.completed !== undefined) conditions.push(eq(followUpTodos.completed, raw.completed));
  if (raw.priority) conditions.push(eq(followUpTodos.priority, raw.priority));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(followUpTodos).where(where).orderBy(followUpTodos.dueDate).limit(limit).offset(offset),
    db.select({ total: count() }).from(followUpTodos).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Create todo
router.post('/todos', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const body = todoSchema.parse(await c.req.json());
  const [row] = await db.insert(followUpTodos).values({
    ...body,
    tenantId,
    agentId: userId,
    dueDate: new Date(body.dueDate),
  }).returning();
  return c.json(row, 201);
});

// Mark todo complete
router.put('/todos/:id/complete', async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const [row] = await db.update(followUpTodos)
    .set({ completed: true, completedAt: new Date() })
    .where(and(
      eq(followUpTodos.id, c.req.param('id')),
      eq(followUpTodos.tenantId, tenantId),
      eq(followUpTodos.agentId, userId),
    ))
    .returning();
  if (!row) throw new NotFound('Todo not found');
  return c.json(row);
});

export default router;
