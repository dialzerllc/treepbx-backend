import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { teams, queues, users } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const teamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  supervisorId: z.string().uuid().nullable().optional(),
});

const queueSchema = z.object({
  name: z.string().min(1),
  strategy: z.enum(['longest_idle', 'round_robin', 'least_calls', 'skills_based']).default('longest_idle'),
  maxWaitSeconds: z.number().int().positive().default(300),
  announcePosition: z.boolean().default(true),
  announceIntervalSeconds: z.number().int().positive().default(30),
  maxQueueSize: z.number().int().positive().default(50),
  musicOnHoldId: z.string().uuid().nullable().optional(),
  timeoutDestination: z.string().optional(),
  afterHoursEnabled: z.boolean().default(false),
});

// List teams
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = eq(teams.tenantId, tenantId);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(teams).where(where).orderBy(desc(teams.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(teams).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Get team with queue config
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [team] = await db.select().from(teams)
    .where(and(eq(teams.id, c.req.param('id')), eq(teams.tenantId, tenantId)));
  if (!team) throw new NotFound('Team not found');

  const [queue] = await db.select().from(queues)
    .where(and(eq(queues.teamId, team.id), eq(queues.tenantId, tenantId)));

  const members = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    email: users.email,
    role: users.role,
    status: users.status,
  }).from(users).where(and(eq(users.teamId, team.id), eq(users.tenantId, tenantId)));

  return c.json({ ...team, queue: queue ?? null, members });
});

// Create team
router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = teamSchema.parse(await c.req.json());
  const [row] = await db.insert(teams).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

// Update team
router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = teamSchema.partial().parse(await c.req.json());
  const [row] = await db.update(teams).set(body)
    .where(and(eq(teams.id, c.req.param('id')), eq(teams.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Team not found');
  return c.json(row);
});

// Delete team
router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(teams)
    .where(and(eq(teams.id, c.req.param('id')), eq(teams.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Team not found');
  return c.json({ ok: true });
});

// Upsert queue config for team
router.put('/:id/queue', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const teamId = c.req.param('id');
  const [team] = await db.select({ id: teams.id }).from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)));
  if (!team) throw new NotFound('Team not found');

  const body = queueSchema.parse(await c.req.json());
  const [existing] = await db.select({ id: queues.id }).from(queues)
    .where(and(eq(queues.teamId, teamId), eq(queues.tenantId, tenantId)));

  let queue;
  if (existing) {
    [queue] = await db.update(queues).set(body)
      .where(eq(queues.id, existing.id)).returning();
  } else {
    [queue] = await db.insert(queues).values({ ...body, tenantId, teamId }).returning();
  }
  return c.json(queue);
});

// Assign agents to team
router.put('/:id/agents', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const teamId = c.req.param('id');
  const [team] = await db.select({ id: teams.id }).from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)));
  if (!team) throw new NotFound('Team not found');

  const body = z.object({ agentIds: z.array(z.string().uuid()) }).parse(await c.req.json());

  // Remove all agents from team first
  await db.update(users).set({ teamId: null })
    .where(and(eq(users.teamId, teamId), eq(users.tenantId, tenantId)));

  // Assign new agents
  if (body.agentIds.length) {
    await db.update(users).set({ teamId })
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, body.agentIds)));
  }

  return c.json({ ok: true, assigned: body.agentIds.length });
});

export default router;
