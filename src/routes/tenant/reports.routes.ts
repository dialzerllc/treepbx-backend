import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, gte, lte, desc, count, sum, avg, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, callRecordings, users, campaigns, agentSessions, tenants, plans, rateGroups, rateCards } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';
import { optionalUuid } from '../../lib/zod-helpers';

const router = new Hono();

const dateRangeSchema = z.object({
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
});

// CDR - Call Detail Records
router.get('/cdr', requireRole('super_admin', 'platform_supervisor', 'tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId');
  const raw = paginationSchema.extend({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    agentId: optionalUuid(),
    campaignId: optionalUuid(),
    direction: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    disposition: z.string().nullable().optional(),
    tenantId: optionalUuid(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const effectiveTenantId = tenantId ?? raw.tenantId;
  const conditions: any[] = [];
  if (effectiveTenantId) conditions.push(eq(calls.tenantId, effectiveTenantId));
  if (raw.from) conditions.push(gte(calls.startedAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(calls.startedAt, new Date(raw.to)));
  if (raw.agentId) conditions.push(eq(calls.agentId, raw.agentId));
  if (raw.campaignId) conditions.push(eq(calls.campaignId, raw.campaignId));
  if (raw.direction) conditions.push(eq(calls.direction, raw.direction));
  if (raw.status) conditions.push(eq(calls.status, raw.status));
  if (raw.disposition) conditions.push(eq(calls.disposition, raw.disposition));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: calls.id,
      caller: calls.callerId,
      callee: calls.calleeNumber,
      direction: calls.direction,
      disposition: calls.disposition,
      hangupCause: calls.hangupCause,
      durationSeconds: calls.durationSeconds,
      waitTimeSeconds: calls.waitTimeSeconds,
      cost: calls.cost,
      ratePerMinute: calls.ratePerMinute,
      startedAt: calls.startedAt,
      agentFirstName: users.firstName,
      agentLastName: users.lastName,
      campaignName: campaigns.name,
    }).from(calls)
      .leftJoin(users, eq(calls.agentId, users.id))
      .leftJoin(campaigns, eq(calls.campaignId, campaigns.id))
      .where(where).orderBy(desc(calls.startedAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(calls).where(where),
  ]);

  // Pre-load tenant rate cards for cost calculation when cost is null
  let rateCardCache: { countryCode: string; direction: string; ratePerMinute: string }[] | null = null;
  const needsRateCalc = rows.some((r) => !r.cost && (r.durationSeconds ?? 0) > 0);
  if (needsRateCalc && effectiveTenantId) {
    try {
      const [t] = await db.select({ planId: tenants.planId }).from(tenants).where(eq(tenants.id, effectiveTenantId));
      if (t?.planId) {
        const [p] = await db.select({ rateGroupId: plans.rateGroupId }).from(plans).where(eq(plans.id, t.planId));
        if (p?.rateGroupId) {
          rateCardCache = await db.select({
            countryCode: rateCards.countryCode,
            direction: rateCards.direction,
            ratePerMinute: rateCards.ratePerMinute,
          }).from(rateCards).where(eq(rateCards.rateGroupId, p.rateGroupId));
        }
      }
    } catch { /* rate lookup failed — costs stay at 0 */ }
  }

  function lookupRate(number: string, direction: string): number {
    if (!rateCardCache) return 0;
    const cleaned = (number ?? '').replace(/[\s\-()]/g, '').replace(/^00/, '').replace(/^\+/, '');
    const dirCards = rateCardCache
      .filter((c) => c.direction === direction)
      .sort((a, b) => b.countryCode.length - a.countryCode.length);
    const match = dirCards.find((c) => cleaned.startsWith(c.countryCode.replace('+', '')));
    return match ? parseFloat(match.ratePerMinute) : 0;
  }

  const data = rows.map((r) => {
    const dur = r.durationSeconds ?? 0;
    const wait = r.waitTimeSeconds ?? 0;

    let cost = Number(r.cost ?? 0);
    let rate = Number(r.ratePerMinute ?? 0);
    // Calculate cost on the fly if not billed yet
    if (cost === 0 && dur > 0) {
      if (rate === 0) {
        const dir = r.direction === 'inbound' ? 'inbound' : 'outbound';
        const number = dir === 'outbound' ? (r.callee ?? '') : (r.caller ?? '');
        rate = lookupRate(number, dir);
      }
      if (rate > 0) {
        const billSec = Math.ceil(dur / 6) * 6;
        cost = (billSec / 60) * rate;
      }
    }

    return {
      id: r.id,
      caller: r.caller,
      callee: r.callee,
      agent: [r.agentFirstName, r.agentLastName].filter(Boolean).join(' ') || '—',
      direction: r.direction,
      duration: `${Math.floor(dur / 60)}m ${dur % 60}s`,
      disposition: r.disposition ?? '',
      campaign: r.campaignName ?? '—',
      date: r.startedAt ? new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 19) : '',
      cost: `$${cost.toFixed(4)}`,
      ratePerMinute: rate > 0 ? `$${rate.toFixed(4)}` : undefined,
      waitTime: `${Math.floor(wait / 60)}m ${wait % 60}s`,
      hangupCause: r.hangupCause ?? '',
    };
  });
  return c.json(paginatedResponse(data, Number(total), raw));
});

// Recordings
router.get('/recordings', requireRole('super_admin', 'platform_supervisor', 'tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId');
  const raw = paginationSchema.extend({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    transcriptStatus: z.string().nullable().optional(),
    tenantId: optionalUuid(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const effectiveTenantId = tenantId ?? raw.tenantId;
  const conditions: any[] = [];
  if (effectiveTenantId) conditions.push(eq(callRecordings.tenantId, effectiveTenantId));
  if (raw.from) conditions.push(gte(callRecordings.createdAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(callRecordings.createdAt, new Date(raw.to)));
  if (raw.transcriptStatus) conditions.push(eq(callRecordings.transcriptStatus, raw.transcriptStatus));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: callRecordings.id,
      callId: callRecordings.callId,
      durationSeconds: callRecordings.durationSeconds,
      sizeBytes: callRecordings.sizeBytes,
      createdAt: callRecordings.createdAt,
      caller: calls.callerId,
      disposition: calls.disposition,
      agentFirstName: users.firstName,
      agentLastName: users.lastName,
      campaignName: campaigns.name,
    }).from(callRecordings)
      .leftJoin(calls, eq(callRecordings.callId, calls.id))
      .leftJoin(users, eq(calls.agentId, users.id))
      .leftJoin(campaigns, eq(calls.campaignId, campaigns.id))
      .where(where).orderBy(desc(callRecordings.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(callRecordings).where(where),
  ]);

  const data = rows.map((r) => {
    const dur = r.durationSeconds ?? 0;
    const bytes = r.sizeBytes ?? 0;
    return {
      id: r.id,
      caller: r.caller ?? '—',
      agent: [r.agentFirstName, r.agentLastName].filter(Boolean).join(' ') || '—',
      campaign: r.campaignName ?? '—',
      disposition: r.disposition ?? '',
      duration: `${Math.floor(dur / 60)}m ${dur % 60}s`,
      date: r.createdAt ? new Date(r.createdAt).toISOString().replace('T', ' ').slice(0, 19) : '',
      size: bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`,
    };
  });
  return c.json(paginatedResponse(data, Number(total), raw));
});

// Play recording
router.get('/recordings/:id/play', requireRole('super_admin', 'platform_supervisor', 'tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({ id: callRecordings.id, minioKey: callRecordings.minioKey })
    .from(callRecordings).where(and(eq(callRecordings.id, c.req.param('id')), eq(callRecordings.tenantId, tenantId)));
  if (!row) throw new NotFound('Recording not found');
  return c.json({ ok: true, streamUrl: `/stream/${row.minioKey}` });
});

// Download recording
router.get('/recordings/:id/download', requireRole('super_admin', 'platform_supervisor', 'tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({ id: callRecordings.id, minioKey: callRecordings.minioKey })
    .from(callRecordings).where(and(eq(callRecordings.id, c.req.param('id')), eq(callRecordings.tenantId, tenantId)));
  if (!row) throw new NotFound('Recording not found');
  return c.json({ url: `/stream/${row.minioKey}?download=1` });
});

// Delete recording
router.delete('/recordings/:id', requireRole('super_admin', 'tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(callRecordings)
    .where(and(eq(callRecordings.id, c.req.param('id')), eq(callRecordings.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Recording not found');
  return c.json({ ok: true });
});

// Agent performance
router.get('/agents', requireRole('super_admin', 'platform_supervisor', 'tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId');
  const raw = z.object({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    tenantId: optionalUuid(),
  }).passthrough().parse(c.req.query());

  const effectiveTenantId = tenantId ?? raw.tenantId;
  const conditions: any[] = [];
  if (effectiveTenantId) conditions.push(eq(calls.tenantId, effectiveTenantId));
  if (raw.from) conditions.push(gte(calls.startedAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(calls.startedAt, new Date(raw.to)));
  const where = and(...conditions);

  const rows = await db.select({
    agentId: calls.agentId,
    agentFirstName: users.firstName,
    agentLastName: users.lastName,
    totalCalls: count(),
    answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')`,
    avgDurationSec: avg(calls.durationSeconds),
    totalTalkSeconds: sum(calls.talkTimeSeconds),
    totalHoldSeconds: sum(calls.holdTimeSeconds),
    totalWrapSeconds: sum(calls.wrapTimeSeconds),
    totalWaitSeconds: sum(calls.waitTimeSeconds),
  }).from(calls)
    .leftJoin(users, eq(calls.agentId, users.id))
    .where(where).groupBy(calls.agentId, users.firstName, users.lastName);

  const data = rows.map((r) => {
    const avgSec = Math.round(Number(r.avgDurationSec ?? 0));
    const talkSec = Number(r.totalTalkSeconds ?? 0);
    const holdSec = Number(r.totalHoldSeconds ?? 0);
    const wrapSec = Number(r.totalWrapSeconds ?? 0);
    const totalActive = talkSec + holdSec + wrapSec;
    const utilization = totalActive > 0 ? Math.min(100, Math.round((talkSec / (totalActive || 1)) * 100)) : 0;
    const fmtTime = (s: number) => s >= 3600 ? `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m` : `${Math.floor(s/60)}m ${s%60}s`;
    return {
      agent: [r.agentFirstName, r.agentLastName].filter(Boolean).join(' ') || '—',
      calls: Number(r.totalCalls),
      answered: Number(r.answered),
      avgDuration: `${Math.floor(avgSec/60)}m ${avgSec%60}s`,
      avgWrap: fmtTime(Math.round(wrapSec / (Number(r.totalCalls) || 1))),
      dispositionRate: `${Number(r.totalCalls) > 0 ? ((Number(r.answered) / Number(r.totalCalls)) * 100).toFixed(1) : '0'}%`,
      loginTime: '—',
      talkTime: fmtTime(talkSec),
      holdTime: fmtTime(holdSec),
      wrapTime: fmtTime(wrapSec),
      idleTime: '—',
      breakTime: '—',
      utilization,
    };
  });
  return c.json({ data });
});

// Campaign summary
router.get('/campaigns', requireRole('super_admin', 'platform_supervisor', 'tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId');
  const raw = z.object({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    tenantId: optionalUuid(),
  }).passthrough().parse(c.req.query());

  const effectiveTenantId = tenantId ?? raw.tenantId;
  const conditions: any[] = [];
  if (effectiveTenantId) conditions.push(eq(calls.tenantId, effectiveTenantId));
  if (raw.from) conditions.push(gte(calls.startedAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(calls.startedAt, new Date(raw.to)));
  const where = and(...conditions);

  const rows = await db.select({
    campaignId: calls.campaignId,
    campaignName: campaigns.name,
    totalCalls: count(),
    answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')`,
    avgDurationSec: avg(calls.durationSeconds),
    totalCost: sum(calls.cost),
    topDisposition: sql<string>`mode() within group (order by ${calls.disposition})`,
  }).from(calls)
    .leftJoin(campaigns, eq(calls.campaignId, campaigns.id))
    .where(where).groupBy(calls.campaignId, campaigns.name);

  const data = rows.map((r) => {
    const total = Number(r.totalCalls);
    const ans = Number(r.answered);
    const avgSec = Math.round(Number(r.avgDurationSec ?? 0));
    return {
      campaign: r.campaignName ?? '—',
      calls: total,
      answeredPct: `${total > 0 ? ((ans / total) * 100).toFixed(1) : '0'}%`,
      avgDuration: `${Math.floor(avgSec/60)}m ${avgSec%60}s`,
      cost: `$${Number(r.totalCost ?? 0).toFixed(2)}`,
      topDisposition: r.topDisposition ?? '—',
    };
  });
  return c.json({ data });
});

// Export - placeholder
router.post('/export', requireRole('super_admin', 'platform_supervisor', 'tenant_admin', 'supervisor'), async (c) => {
  const body = z.object({
    type: z.enum(['cdr', 'recordings', 'agents', 'campaigns']),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    format: z.enum(['csv', 'xlsx']).default('csv'),
  }).passthrough().parse(await c.req.json());

  return c.json({ ok: true, message: 'Export queued', downloadUrl: null }, 202);
});

export default router;
