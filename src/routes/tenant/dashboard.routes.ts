import { Hono } from 'hono';
import { eq, and, isNull, inArray, count, sum, gte } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, calls, campaigns, agentSessions, wallets, followUpTodos } from '../../db/schema';

const router = new Hono();

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    [{ totalAgents }],
    [{ onlineAgents }],
    [{ callsToday }],
    [{ activeCalls }],
    [{ runningCampaigns }],
    [{ pendingTodos }],
    walletData,
  ] = await Promise.all([
    db.select({ totalAgents: count() }).from(users)
      .where(and(
        eq(users.tenantId, tenantId),
        inArray(users.role, ['agent', 'supervisor']),
        isNull(users.deletedAt),
      )),
    db.select({ onlineAgents: count() }).from(users)
      .where(and(
        eq(users.tenantId, tenantId),
        inArray(users.role, ['agent', 'supervisor']),
        inArray(users.status, ['online', 'on_call', 'wrap_up']),
        isNull(users.deletedAt),
      )),
    db.select({ callsToday: count() }).from(calls)
      .where(and(eq(calls.tenantId, tenantId), gte(calls.startedAt, todayStart))),
    db.select({ activeCalls: count() }).from(calls)
      .where(and(
        eq(calls.tenantId, tenantId),
        inArray(calls.status, ['ringing', 'answered']),
      )),
    db.select({ runningCampaigns: count() }).from(campaigns)
      .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.status, 'active'))),
    db.select({ pendingTodos: count() }).from(followUpTodos)
      .where(and(eq(followUpTodos.tenantId, tenantId), eq(followUpTodos.completed, false))),
    db.select({ balance: wallets.balance, currency: wallets.currency })
      .from(wallets).where(eq(wallets.tenantId, tenantId)),
  ]);

  // Call stats for today
  const todayCalls = await db.select({
    totalCost: sum(calls.cost),
    answeredCalls: count(),
  }).from(calls)
    .where(and(
      eq(calls.tenantId, tenantId),
      gte(calls.startedAt, todayStart),
      eq(calls.status, 'completed'),
    ));

  return c.json({
    agents: {
      total: Number(totalAgents),
      online: Number(onlineAgents),
    },
    calls: {
      today: Number(callsToday),
      active: Number(activeCalls),
      answeredToday: Number(todayCalls[0]?.answeredCalls ?? 0),
      costToday: todayCalls[0]?.totalCost ?? '0',
    },
    campaigns: {
      running: Number(runningCampaigns),
    },
    todos: {
      pending: Number(pendingTodos),
    },
    wallet: walletData[0] ?? { balance: '0', currency: 'USD' },
  });
});

export default router;
