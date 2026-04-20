import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, gte, lte, like, count, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, users, campaigns, dids, tenants, ivrMenus, queues, plans, rateCards } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

// List call traces for this tenant
router.get('/', requireRole('super_admin', 'platform_supervisor', 'tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId');
  const raw = paginationSchema.extend({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    callerId: z.string().nullable().optional(),
    calleeNumber: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    direction: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [];
  if (tenantId) conditions.push(eq(calls.tenantId, tenantId));
  if (raw.from) conditions.push(gte(calls.startedAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(calls.startedAt, new Date(raw.to)));
  if (raw.callerId) conditions.push(like(calls.callerId, `%${raw.callerId}%`));
  if (raw.calleeNumber) conditions.push(like(calls.calleeNumber, `%${raw.calleeNumber}%`));
  if (raw.status) conditions.push(eq(calls.status, raw.status));
  if (raw.direction) conditions.push(eq(calls.direction, raw.direction));
  if (raw.agentId) conditions.push(eq(calls.agentId, raw.agentId));
  if (raw.search) {
    conditions.push(like(calls.callerId, `%${raw.search}%`));
  }
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: calls.id,
      uuid: calls.freeswitchUuid,
      caller: calls.callerId,
      callerName: calls.callerName,
      callee: calls.calleeNumber,
      calleeName: calls.calleeName,
      direction: calls.direction,
      status: calls.status,
      disposition: calls.disposition,
      hangupCause: calls.hangupCause,
      startedAt: calls.startedAt,
      answeredAt: calls.answeredAt,
      endedAt: calls.endedAt,
      durationSeconds: calls.durationSeconds,
      talkTimeSeconds: calls.talkTimeSeconds,
      waitTimeSeconds: calls.waitTimeSeconds,
      holdTimeSeconds: calls.holdTimeSeconds,
      agentId: calls.agentId,
      campaignId: calls.campaignId,
      didId: calls.didId,
      carrier: calls.carrier,
      carrierIp: calls.carrierIp,
      codec: calls.codec,
      sipUserAgent: calls.userAgent,
      sipFromUri: calls.sipFromUri,
      sipToUri: calls.sipToUri,
      mos: calls.mos,
      jitterMs: calls.jitterMs,
      packetLossPct: calls.packetLossPct,
      cost: calls.cost,
      ratePerMinute: calls.ratePerMinute,
      billingSeconds: calls.billingSeconds,
      amdResult: calls.amdResult,
      fraudFlagged: calls.fraudFlagged,
      recordingUrl: calls.recordingUrl,
      // Joined fields
      tenantName: tenants.name,
      agentFirstName: users.firstName,
      agentLastName: users.lastName,
      campaignName: campaigns.name,
      didNumber: dids.number,
      didRouteType: dids.routeType,
      didRouteTargetId: dids.routeTargetId,
      // IVR name: when DID routes to IVR
      ivrName: sql<string>`(SELECT name FROM ivr_menus WHERE id = ${dids.routeTargetId} LIMIT 1)`.as('ivr_name'),
      // Queue name: direct (DID→queue) or via IVR timeout (DID→IVR→queue)
      queueName: sql<string>`COALESCE(
        (SELECT name FROM queues WHERE id = ${dids.routeTargetId} LIMIT 1),
        (SELECT q.name FROM ivr_menus i JOIN queues q ON q.id = i.timeout_target_id WHERE i.id = ${dids.routeTargetId} LIMIT 1)
      )`.as('queue_name'),
    }).from(calls)
      .leftJoin(tenants, eq(calls.tenantId, tenants.id))
      .leftJoin(users, eq(calls.agentId, users.id))
      .leftJoin(campaigns, eq(calls.campaignId, campaigns.id))
      .leftJoin(dids, eq(calls.didId, dids.id))
      .where(where).orderBy(desc(calls.startedAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(calls).where(where),
  ]);

  // Pre-load rate cards for cost calculation when cost is null
  let rateCardCache: { countryCode: string; direction: string; ratePerMinute: string }[] | null = null;
  const needsRateCalc = rows.some((r) => !r.cost && (r.durationSeconds ?? 0) > 0);
  if (needsRateCalc && tenantId) {
    try {
      const [t] = await db.select({ planId: tenants.planId }).from(tenants).where(eq(tenants.id, tenantId));
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
    } catch { /* rate lookup failed */ }
  }

  const data = rows.map((r) => {
    const dur = r.durationSeconds ?? 0;
    const talkDur = r.talkTimeSeconds ?? dur;

    // Calculate cost if not billed
    let cost = Number(r.cost ?? 0);
    let rate = Number(r.ratePerMinute ?? 0);
    if (cost === 0 && dur > 0 && rateCardCache) {
      const dir = r.direction === 'inbound' ? 'inbound' : 'outbound';
      const number = (dir === 'outbound' ? (r.callee ?? '') : (r.caller ?? '')).replace(/[\s\-()]/g, '').replace(/^00/, '').replace(/^\+/, '');
      const dirCards = rateCardCache.filter((c) => c.direction === dir).sort((a, b) => b.countryCode.length - a.countryCode.length);
      const match = dirCards.find((c) => number.startsWith(c.countryCode.replace('+', '')));
      if (match) {
        rate = parseFloat(match.ratePerMinute);
        const billSec = Math.ceil(dur / 6) * 6;
        cost = (billSec / 60) * rate;
      }
    }

    return {
      ...r,
      cost: cost > 0 ? `$${cost.toFixed(4)}` : r.cost,
      ratePerMinute: rate > 0 ? `$${rate.toFixed(4)}` : r.ratePerMinute,
      uuid: r.uuid ?? r.id,
      startTime: r.startedAt ? new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 19) : '',
      answerTime: r.answeredAt ? new Date(r.answeredAt).toISOString().replace('T', ' ').slice(0, 19) : '',
      endTime: r.endedAt ? new Date(r.endedAt).toISOString().replace('T', ' ').slice(0, 19) : '',
      duration: dur > 0 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : '0s',
      carrierIP: r.carrierIp,
      jitter: r.jitterMs ? Number(r.jitterMs) : undefined,
      packetLoss: r.packetLossPct ? Number(r.packetLossPct) : undefined,
      mos: r.mos ? Number(r.mos) : undefined,
      // SIP details for frontend
      fromSIP: r.sipFromUri ?? undefined,
      toSIP: r.sipToUri ?? undefined,
      userAgent: r.sipUserAgent ?? undefined,
      codec: r.codec ?? undefined,
      // Resolved names
      tenant: r.tenantName ?? undefined,
      agent: r.agentFirstName ? `${r.agentFirstName} ${r.agentLastName}` : undefined,
      campaign: r.campaignName ?? undefined,
      did: r.didNumber ?? undefined,
      ivr: r.ivrName ?? undefined,
      queue: r.queueName ?? undefined,
      // Recording info
      recorded: !!r.recordingUrl,
      recordingDuration: talkDur > 0 ? `${Math.floor(talkDur / 60)}m ${talkDur % 60}s` : undefined,
      // Events with correct shape for frontend
      events: [
        { timestamp: r.startedAt ? new Date(r.startedAt).toISOString().replace('T', ' ').slice(11, 19) : '', type: r.direction === 'outbound' ? 'INVITE' : 'INVITE', direction: 'sent' as const, from: r.caller, to: r.callee, description: r.direction === 'outbound' ? 'Outbound call initiated' : 'Inbound call received' },
        ...(r.answeredAt ? [{ timestamp: new Date(r.answeredAt).toISOString().replace('T', ' ').slice(11, 19), type: 'OK', direction: 'received' as const, from: r.callee, to: r.caller, description: 'Call answered' }] : []),
        ...(r.recordingUrl ? [{ timestamp: r.answeredAt ? new Date(r.answeredAt).toISOString().replace('T', ' ').slice(11, 19) : '', type: 'RECORDING', direction: 'sent' as const, from: r.caller, to: r.callee, description: 'Recording started' }] : []),
        ...(r.endedAt ? [{ timestamp: new Date(r.endedAt).toISOString().replace('T', ' ').slice(11, 19), type: 'BYE', direction: 'sent' as const, from: r.caller, to: r.callee, description: r.hangupCause ?? 'Call ended' }] : []),
      ],
    };
  });

  return c.json(paginatedResponse(data, Number(total), raw));
});

// Get single call detail
router.get('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(calls)
    .where(and(eq(calls.id, c.req.param('id')), eq(calls.tenantId, tenantId)));
  if (!row) throw new NotFound('Call not found');
  return c.json(row);
});

export default router;
