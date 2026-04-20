import { Hono } from 'hono';
import { eq, and, sql, inArray, gte, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, teams, queues, calls } from '../../db/schema';

const router = new Hono();

// GET /teams — teams this supervisor manages
router.get('/teams', async (c) => {
  const tenantId = c.get('tenantId')!;

  const rows = await db.select({
    id: teams.id,
    name: teams.name,
    queueId: queues.id,
    queueName: queues.name,
    strategy: queues.strategy,
  })
    .from(teams)
    .leftJoin(queues, eq(queues.teamId, teams.id))
    .where(eq(teams.tenantId, tenantId));

  return c.json({ data: rows });
});

// GET /agents — all agents with live status
router.get('/agents', async (c) => {
  const tenantId = c.get('tenantId')!;
  const teamId = c.req.query('teamId');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const conditions = [
    eq(users.tenantId, tenantId),
    inArray(users.role, ['agent', 'supervisor', 'tenant_admin']),
    isNull(users.deletedAt),
  ];
  if (teamId && teamId !== 'all') conditions.push(eq(users.teamId, teamId));

  const agents = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    role: users.role,
    status: users.status,
    statusChangedAt: users.statusChangedAt,
    teamId: users.teamId,
  }).from(users).where(and(...conditions));

  // Enrich with today's call count
  const agentIds = agents.map((a) => a.id);
  const callStats = agentIds.length > 0
    ? await db.select({
        agentId: calls.agentId,
        callsHandled: sql<number>`count(*)::int`,
        avgHandle: sql<number>`coalesce(avg(${calls.durationSeconds}), 0)::int`,
      })
        .from(calls)
        .where(and(inArray(calls.agentId, agentIds), gte(calls.startedAt, today)))
        .groupBy(calls.agentId)
    : [];

  const statsMap = new Map(callStats.map((s) => [s.agentId, s]));

  const enriched = agents.map((a) => ({
    ...a,
    callsHandled: statsMap.get(a.id)?.callsHandled ?? 0,
    avgHandleTime: statsMap.get(a.id)?.avgHandle ?? 0,
  }));

  return c.json({ data: enriched });
});

// GET /calls — active calls across teams
router.get('/calls', async (c) => {
  const tenantId = c.get('tenantId')!;

  const activeCalls = await db.select({
    id: calls.id,
    agentId: calls.agentId,
    callerId: calls.callerId,
    callerName: calls.callerName,
    calleeNumber: calls.calleeNumber,
    direction: calls.direction,
    status: calls.status,
    startedAt: calls.startedAt,
    campaignId: calls.campaignId,
  })
    .from(calls)
    .where(and(
      eq(calls.tenantId, tenantId),
      inArray(calls.status, ['ringing', 'answered']),
    ));

  return c.json({ data: activeCalls });
});

// GET /queue/callers — callers waiting in queues
router.get('/queue/callers', async (c) => {
  const tenantId = c.get('tenantId')!;

  // Find calls in ringing state (waiting in queue)
  const callers = await db.select({
    id: calls.id,
    callerId: calls.callerId,
    callerName: calls.callerName,
    calleeNumber: calls.calleeNumber,
    status: calls.status,
    startedAt: calls.startedAt,
    campaignId: calls.campaignId,
  })
    .from(calls)
    .where(and(
      eq(calls.tenantId, tenantId),
      eq(calls.status, 'ringing'),
    ))
    .orderBy(calls.startedAt);

  return c.json({ data: callers });
});

// GET /queue/stats — queue statistics
router.get('/queue/stats', async (c) => {
  const tenantId = c.get('tenantId')!;

  const queueList = await db.select({
    id: queues.id,
    name: queues.name,
    teamId: queues.teamId,
    strategy: queues.strategy,
  }).from(queues).where(eq(queues.tenantId, tenantId));

  return c.json({ data: queueList.map((q) => ({
    ...q,
    callsWaiting: 0,
    longestWaitSeconds: 0,
    callsAnswered: 0,
    callsAbandoned: 0,
    avgWaitSeconds: 0,
    serviceLevel: 100,
  })) });
});

// POST /listen/:agentId — silent monitoring (ESL stub)
router.post('/listen/:agentId', async (c) => {
  return c.json({ ok: true, action: 'listen', agentId: c.req.param('agentId') });
});

// POST /whisper/:agentId
router.post('/whisper/:agentId', async (c) => {
  return c.json({ ok: true, action: 'whisper', agentId: c.req.param('agentId') });
});

// POST /barge/:agentId
router.post('/barge/:agentId', async (c) => {
  return c.json({ ok: true, action: 'barge', agentId: c.req.param('agentId') });
});

export default router;
