import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { teams, queues, users } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const teamSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  supervisorId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  scriptId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  skills: z.array(z.string()).nullable().optional().default([]),
});

const queueSchema = z.object({
  name: z.string().min(1),
  strategy: z.enum(['longest_idle', 'round_robin', 'least_calls', 'skills_based']).default('longest_idle'),
  maxWaitSeconds: z.coerce.number().int().default(300),
  announcePosition: z.boolean().nullable().default(true),
  announceIntervalSeconds: z.coerce.number().int().default(30),
  maxQueueSize: z.coerce.number().int().default(50),
  musicOnHoldId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  timeoutDestination: z.string().nullable().optional(),
  afterHoursEnabled: z.boolean().nullable().default(false),
});

// List teams
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;

  const { cacheGet, cacheSet } = await import('../../lib/redis');
  const cacheKey = `teams:${tenantId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = eq(teams.tenantId, tenantId);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(teams).where(where).orderBy(desc(teams.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(teams).where(where),
  ]);

  // Enrich with agent count and supervisor name per team (batch queries instead of N+1)
  const { isNull } = await import('drizzle-orm');
  const teamIds = rows.map((r) => r.id);

  // Batch: agent counts per team
  const agentCounts = teamIds.length > 0
    ? await db.select({ teamId: users.teamId, agentCount: count() }).from(users)
        .where(and(inArray(users.teamId, teamIds), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
        .groupBy(users.teamId)
    : [];
  const agentCountMap = Object.fromEntries(agentCounts.map((r) => [r.teamId, Number(r.agentCount)]));

  // Batch: supervisor names
  const supervisorIds = rows.map((r) => r.supervisorId).filter((id): id is string => !!id);
  const supervisorRows = supervisorIds.length > 0
    ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users)
        .where(inArray(users.id, supervisorIds))
    : [];
  const supervisorMap = Object.fromEntries(supervisorRows.map((s) => [s.id, [s.firstName, s.lastName].filter(Boolean).join(' ') || null]));

  const enriched = rows.map((t) => ({
    ...t,
    agents: agentCountMap[t.id] ?? 0,
    supervisor: t.supervisorId ? (supervisorMap[t.supervisorId] ?? null) : null,
  }));

  const result = paginatedResponse(enriched, Number(total), raw);
  await cacheSet(cacheKey, result, 15);
  return c.json(result);
});

// List all queues for this tenant
router.get('/queues', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select().from(queues)
    .where(eq(queues.tenantId, tenantId))
    .orderBy(desc(queues.createdAt));
  return c.json({ data: rows });
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

  const [dup] = await db.select({ id: teams.id }).from(teams)
    .where(and(eq(teams.name, body.name), eq(teams.tenantId, tenantId)));
  if (dup) throw new BadRequest('Team name already exists');

  const [row] = await db.insert(teams).values({ ...body, tenantId }).returning();
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`teams:${tenantId}*`);
  return c.json(row, 201);
});

// Update team
router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = teamSchema.partial().parse(await c.req.json());

  if (body.name) {
    const [dup] = await db.select({ id: teams.id }).from(teams)
      .where(and(eq(teams.name, body.name), eq(teams.tenantId, tenantId), sql`${teams.id} != ${c.req.param('id')}`));
    if (dup) throw new BadRequest('Team name already exists');
  }

  const [row] = await db.update(teams).set(body)
    .where(and(eq(teams.id, c.req.param('id')), eq(teams.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Team not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`teams:${tenantId}*`);
  return c.json(row);
});

// Delete team
router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const teamId = c.req.param('id');

  // Remove FK references before deleting
  await db.delete(queues).where(eq(queues.teamId, teamId));
  await db.update(users).set({ teamId: null }).where(eq(users.teamId, teamId));

  const [row] = await db.delete(teams)
    .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Team not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`teams:${tenantId}*`);
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

  const body = z.object({ agentIds: z.array(z.string().uuid()) }).passthrough().parse(await c.req.json());

  // Remove all agents from team first
  await db.update(users).set({ teamId: null })
    .where(and(eq(users.teamId, teamId), eq(users.tenantId, tenantId)));

  // Assign new agents
  if (body.agentIds.length) {
    await db.update(users).set({ teamId })
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, body.agentIds)));
  }

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`teams:${tenantId}*`);
  return c.json({ ok: true, assigned: body.agentIds.length });
});

export default router;
