import { Hono } from 'hono';
import { z } from 'zod';
import { optionalUuid } from '../../lib/zod-helpers';
import { eq, and, like, desc, count, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, users, campaigns, dids, tenants, ivrMenus, queues } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    tenantId: optionalUuid(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    callerId: z.string().nullable().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [];  // Show all calls including WebRTC (no freeswitchUuid filter)
  if (raw.tenantId) conditions.push(eq(calls.tenantId, raw.tenantId));
  if (raw.callerId) conditions.push(like(calls.callerId, `%${raw.callerId}%`));
  if (raw.from) conditions.push(gte(calls.startedAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(calls.startedAt, new Date(raw.to)));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: calls.id,
      tenantId: calls.tenantId,
      freeswitchUuid: calls.freeswitchUuid,
      direction: calls.direction,
      callerId: calls.callerId,
      callerName: calls.callerName,
      calleeNumber: calls.calleeNumber,
      calleeName: calls.calleeName,
      status: calls.status,
      disposition: calls.disposition,
      hangupCause: calls.hangupCause,
      startedAt: calls.startedAt,
      answeredAt: calls.answeredAt,
      endedAt: calls.endedAt,
      durationSeconds: calls.durationSeconds,
      talkTimeSeconds: calls.talkTimeSeconds,
      holdTimeSeconds: calls.holdTimeSeconds,
      waitTimeSeconds: calls.waitTimeSeconds,
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
      ivrName: sql<string>`(SELECT name FROM ivr_menus WHERE id = ${dids.routeTargetId} LIMIT 1)`.as('ivr_name'),
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

  const data = rows.map((r) => {
    const dur = r.durationSeconds ?? 0;
    const talkDur = r.talkTimeSeconds ?? dur;
    return {
      ...r,
      uuid: r.freeswitchUuid ?? r.id,
      caller: r.callerId,
      callerName: r.callerName,
      callee: r.calleeNumber,
      calleeName: r.calleeName,
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
        { timestamp: r.startedAt ? new Date(r.startedAt).toISOString().replace('T', ' ').slice(11, 19) : '', type: r.direction === 'outbound' ? 'INVITE' : 'INVITE', direction: 'sent' as const, from: r.callerId, to: r.calleeNumber, description: r.direction === 'outbound' ? 'Outbound call initiated' : 'Inbound call received' },
        ...(r.answeredAt ? [{ timestamp: new Date(r.answeredAt).toISOString().replace('T', ' ').slice(11, 19), type: 'OK', direction: 'received' as const, from: r.calleeNumber, to: r.callerId, description: 'Call answered' }] : []),
        ...(r.recordingUrl ? [{ timestamp: r.answeredAt ? new Date(r.answeredAt).toISOString().replace('T', ' ').slice(11, 19) : '', type: 'RECORDING', direction: 'sent' as const, from: r.callerId, to: r.calleeNumber, description: 'Recording started' }] : []),
        ...(r.endedAt ? [{ timestamp: new Date(r.endedAt).toISOString().replace('T', ' ').slice(11, 19), type: 'BYE', direction: 'sent' as const, from: r.callerId, to: r.calleeNumber, description: r.hangupCause ?? 'Call ended' }] : []),
      ],
    };
  });

  return c.json(paginatedResponse(data, Number(total), raw));
});

router.get('/:uuid', async (c) => {
  const [row] = await db.select().from(calls).where(eq(calls.freeswitchUuid, c.req.param('uuid')));
  if (!row) throw new NotFound('Call not found');
  return c.json(row);
});

export default router;
