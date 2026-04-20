import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, isNull, inArray, count, sum, sql, gte, desc, like } from 'drizzle-orm';
import { db } from '../../db/client';
import { tenants, users, calls, agentSessions, wallets } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';

const router = new Hono();

router.get('/stats', async (c) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    [{ totalTenants }],
    [{ activeTenants }],
    [{ activeAgents }],
    [{ callsToday }],
    [{ activeCalls }],
    [{ platformUsers }],
  ] = await Promise.all([
    db.select({ totalTenants: count() }).from(tenants).where(isNull(tenants.deletedAt)),
    db.select({ activeTenants: count() }).from(tenants).where(and(eq(tenants.status, 'active'), isNull(tenants.deletedAt))),
    db.select({ activeAgents: count() }).from(agentSessions).where(isNull(agentSessions.logoutAt)),
    db.select({ callsToday: count() }).from(calls).where(gte(calls.startedAt, todayStart)),
    db.select({ activeCalls: count() }).from(calls).where(inArray(calls.status, ['ringing', 'answered'])),
    db.select({ platformUsers: count() }).from(users).where(and(isNull(users.tenantId), isNull(users.deletedAt))),
  ]);

  return c.json({
    totalTenants: Number(totalTenants),
    activeTenants: Number(activeTenants),
    activeAgents: Number(activeAgents),
    callsToday: Number(callsToday),
    activeCalls: Number(activeCalls),
    platformUsers: Number(platformUsers),
  });
});

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    status: z.string().nullable().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [isNull(tenants.deletedAt)];
  if (raw.search) conditions.push(like(tenants.name, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(tenants.status, raw.status));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      planId: tenants.planId,
      maxAgents: tenants.maxAgents,
      maxConcurrentCalls: tenants.maxConcurrentCalls,
      createdAt: tenants.createdAt,
    }).from(tenants).where(where).orderBy(desc(tenants.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(tenants).where(where),
  ]);

  // Enrich with wallet balance and active call count per tenant
  const tenantIds = rows.map((r) => r.id);
  const [walletRows, activeCallRows, agentRows] = tenantIds.length
    ? await Promise.all([
        db.select({ tenantId: wallets.tenantId, balance: wallets.balance }).from(wallets).where(inArray(wallets.tenantId, tenantIds)),
        db.select({ tenantId: calls.tenantId, activeCalls: count() }).from(calls)
          .where(and(inArray(calls.tenantId, tenantIds), inArray(calls.status, ['ringing', 'answered'])))
          .groupBy(calls.tenantId),
        db.select({ tenantId: agentSessions.tenantId, activeAgents: count() }).from(agentSessions)
          .where(and(inArray(agentSessions.tenantId, tenantIds), isNull(agentSessions.logoutAt)))
          .groupBy(agentSessions.tenantId),
      ])
    : [[], [], []];

  const walletMap = Object.fromEntries(walletRows.map((w) => [w.tenantId, w.balance]));
  const callMap = Object.fromEntries(activeCallRows.map((r) => [r.tenantId, Number(r.activeCalls)]));
  const agentMap = Object.fromEntries(agentRows.map((r) => [r.tenantId, Number(r.activeAgents)]));

  const enriched = rows.map((t) => ({
    ...t,
    balance: walletMap[t.id] ?? '0',
    activeCalls: callMap[t.id] ?? 0,
    activeAgents: agentMap[t.id] ?? 0,
  }));

  return c.json(paginatedResponse(enriched, Number(total), raw));
});

export default router;
