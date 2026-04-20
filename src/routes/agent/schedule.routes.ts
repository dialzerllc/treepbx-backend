import { Hono } from 'hono';
import { z } from 'zod';
import { optionalUuid } from '../../lib/zod-helpers';
import { eq, and, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client';
import { scheduleEvents, followUpTodos } from '../../db/schema';

const router = new Hono();

// GET /events — own schedule events
router.get('/events', async (c) => {
  const userId = c.get('user').sub;
  const from = c.req.query('from');
  const to = c.req.query('to');

  const conditions = [eq(scheduleEvents.userId, userId)];
  if (from) conditions.push(gte(scheduleEvents.startTime, new Date(from)));
  if (to) conditions.push(lte(scheduleEvents.endTime, new Date(to)));

  const events = await db.select().from(scheduleEvents)
    .where(and(...conditions))
    .orderBy(scheduleEvents.startTime);

  return c.json({ data: events });
});

// POST /events — create event
const eventSchema = z.object({
  type: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  startTime: z.string().transform((s) => new Date(s)),
  endTime: z.string().transform((s) => new Date(s)),
  leadId: optionalUuid(),
  leadName: z.string().nullable().optional(),
  leadPhone: z.string().nullable().optional(),
  priority: z.string().default('medium'),
  campaignId: optionalUuid(),
});

router.post('/events', async (c) => {
  const userId = c.get('user').sub;
  const tenantId = c.get('tenantId')!;
  const body = eventSchema.parse(await c.req.json());

  const [event] = await db.insert(scheduleEvents).values({
    ...body,
    userId,
    tenantId,
  }).returning();

  return c.json(event, 201);
});

// DELETE /events/:id
router.delete('/events/:id', async (c) => {
  const userId = c.get('user').sub;
  const id = c.req.param('id');
  await db.delete(scheduleEvents).where(and(eq(scheduleEvents.id, id), eq(scheduleEvents.userId, userId)));
  return c.json({ ok: true });
});

// GET /todos — own follow-up todos
router.get('/todos', async (c) => {
  const userId = c.get('user').sub;
  const todos = await db.select().from(followUpTodos)
    .where(eq(followUpTodos.agentId, userId))
    .orderBy(followUpTodos.dueDate);
  return c.json({ data: todos });
});

// POST /todos
const todoSchema = z.object({
  leadName: z.string().nullable().optional(),
  leadPhone: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  priority: z.string().default('medium'),
  dueDate: z.string().transform((s) => new Date(s)),
});

router.post('/todos', async (c) => {
  const userId = c.get('user').sub;
  const tenantId = c.get('tenantId')!;
  const body = todoSchema.parse(await c.req.json());

  const [todo] = await db.insert(followUpTodos).values({
    ...body,
    agentId: userId,
    tenantId,
  }).returning();

  return c.json(todo, 201);
});

// PUT /todos/:id — update todo (frontend sends {completed: boolean})
router.put('/todos/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('user').sub;
  const body = z.object({ completed: z.boolean().optional() }).passthrough().parse(await c.req.json());

  const updates: any = {};
  if (body.completed !== undefined) {
    updates.completed = body.completed;
    updates.completedAt = body.completed ? new Date() : null;
  }

  await db.update(followUpTodos).set(updates)
    .where(and(eq(followUpTodos.id, id), eq(followUpTodos.agentId, userId)));

  return c.json({ ok: true });
});

// PUT /todos/:id/complete (kept for backwards compatibility)
router.put('/todos/:id/complete', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('user').sub;

  await db.update(followUpTodos).set({
    completed: true,
    completedAt: new Date(),
  }).where(and(eq(followUpTodos.id, id), eq(followUpTodos.agentId, userId)));

  return c.json({ ok: true });
});

export default router;
