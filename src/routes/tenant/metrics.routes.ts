import { Hono } from 'hono';
import { eq, and, gte, sql, count, avg, sum, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, users, queues, teams, agentSessions } from '../../db/schema';

const router = new Hono();

// GET / — service metrics for the tenant
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const fromParam = c.req.query('from');
  const sinceDate = fromParam ? new Date(fromParam) : todayStart;

  const callConditions = [eq(calls.tenantId, tenantId), gte(calls.startedAt, sinceDate)];

  // Call metrics
  const [callStats] = await db.select({
    totalCalls: count(),
    answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
    abandoned: sql<number>`count(*) filter (where ${calls.status} = 'abandoned')::int`,
    missed: sql<number>`count(*) filter (where ${calls.status} = 'missed' or ${calls.status} = 'no_answer')::int`,
    avgDuration: sql<number>`coalesce(avg(${calls.durationSeconds}) filter (where ${calls.status} = 'completed'), 0)::int`,
    avgTalkTime: sql<number>`coalesce(avg(${calls.talkTimeSeconds}) filter (where ${calls.status} = 'completed'), 0)::int`,
    avgWaitTime: sql<number>`coalesce(avg(${calls.waitTimeSeconds}), 0)::int`,
    avgWrapTime: sql<number>`coalesce(avg(${calls.wrapTimeSeconds}) filter (where ${calls.status} = 'completed'), 0)::int`,
    maxWaitTime: sql<number>`coalesce(max(${calls.waitTimeSeconds}), 0)::int`,
    totalCost: sum(calls.cost),
  }).from(calls).where(and(...callConditions));

  // Active right now
  const [active] = await db.select({
    activeCalls: count(),
  }).from(calls).where(and(eq(calls.tenantId, tenantId), inArray(calls.status, ['ringing', 'answered'])));

  const [ringing] = await db.select({
    callsWaiting: count(),
  }).from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.status, 'ringing')));

  // Agent metrics
  const [agentStats] = await db.select({
    totalAgents: count(),
    available: sql<number>`count(*) filter (where ${users.status} = 'available')::int`,
    onCall: sql<number>`count(*) filter (where ${users.status} = 'on_call')::int`,
    wrapUp: sql<number>`count(*) filter (where ${users.status} = 'wrap_up')::int`,
    onBreak: sql<number>`count(*) filter (where ${users.status} = 'break')::int`,
    offline: sql<number>`count(*) filter (where ${users.status} = 'offline')::int`,
  }).from(users).where(and(
    eq(users.tenantId, tenantId),
    inArray(users.role, ['agent', 'supervisor', 'tenant_admin']),
    isNull(users.deletedAt),
  ));

  // Service level: % of calls answered within 20 seconds
  const [sl] = await db.select({
    within20: sql<number>`count(*) filter (where ${calls.waitTimeSeconds} <= 20 and ${calls.status} = 'completed')::int`,
    totalAnswerable: sql<number>`count(*) filter (where ${calls.status} in ('completed', 'abandoned', 'missed', 'no_answer'))::int`,
  }).from(calls).where(and(...callConditions));
  const serviceLevel = sl.totalAnswerable > 0 ? Math.round((sl.within20 / sl.totalAnswerable) * 100) : 100;

  // Per-queue stats
  const queueList = await db.select({
    id: queues.id,
    name: queues.name,
    teamId: queues.teamId,
  }).from(queues).where(eq(queues.tenantId, tenantId));

  // Per-team stats
  const teamList = await db.select({
    id: teams.id,
    name: teams.name,
  }).from(teams).where(eq(teams.tenantId, tenantId));

  const teamStats = await Promise.all(teamList.map(async (t) => {
    const [ts] = await db.select({
      totalCalls: count(),
      answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
      avgHandleTime: sql<number>`coalesce(avg(${calls.durationSeconds}) filter (where ${calls.status} = 'completed'), 0)::int`,
      avgWaitTime: sql<number>`coalesce(avg(${calls.waitTimeSeconds}), 0)::int`,
    }).from(calls).where(and(
      eq(calls.tenantId, tenantId),
      gte(calls.startedAt, sinceDate),
      inArray(calls.agentId, db.select({ id: users.id }).from(users).where(eq(users.teamId, t.id))),
    ));
    const [ac] = await db.select({ count: count() }).from(users)
      .where(and(eq(users.teamId, t.id), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
    return {
      teamId: t.id,
      teamName: t.name,
      agents: Number(ac.count),
      totalCalls: ts.totalCalls,
      answered: ts.answered,
      avgHandleTime: ts.avgHandleTime,
      avgWaitTime: ts.avgWaitTime,
    };
  }));

  return c.json({
    period: { from: sinceDate.toISOString(), to: new Date().toISOString() },
    calls: {
      total: callStats.totalCalls,
      answered: callStats.answered,
      abandoned: callStats.abandoned,
      missed: callStats.missed,
      active: active.activeCalls,
      waiting: ringing.callsWaiting,
      avgDuration: callStats.avgDuration,
      avgTalkTime: callStats.avgTalkTime,
      avgWaitTime: callStats.avgWaitTime,
      maxWaitTime: callStats.maxWaitTime,
      avgWrapTime: callStats.avgWrapTime,
      totalCost: callStats.totalCost ?? '0',
      serviceLevel,
      answerRate: callStats.totalCalls > 0 ? Math.round((callStats.answered / callStats.totalCalls) * 100) : 100,
    },
    agents: agentStats,
    teams: teamStats,
    queues: queueList.map((q) => ({
      ...q,
      callsWaiting: 0,
      longestWait: 0,
    })),
  });
});

export default router;
