import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, inArray, sql, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { campaigns, leads, calls, users, dids, queues, ivrMenuActions, leadLists } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';
import { logger } from '../../lib/logger';

const router = new Hono();

const campaignSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['running', 'paused', 'draft', 'completed']).optional(),
  dialMode: z.enum(['preview', 'progressive', 'predictive', 'power', 'voicebot']).default('progressive'),
  leadListId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  leadListIds: z.array(z.string().uuid()).optional(),
  leadListStrategy: z.enum(['sequential', 'round_robin', 'ratio']).default('sequential'),
  didGroupId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  callerIdRotation: z.enum(['use_group_default', 'round_robin', 'sequential', 'random', 'local_match']).nullable().optional(),
  voicebotConfigId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  rateCardId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  scriptId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  // dial_ratio is numeric(4,2) → max 99.99, but a sane predictive ratio is well
  // under 10. maxAbandonRate is a percentage, so 0–100. Validate before
  // touching Postgres so we 400 with a useful message instead of a 500
  // "numeric field overflow".
  dialRatio: z.union([z.number(), z.string()])
    .transform((v) => Number(v))
    .pipe(z.number().min(0.1).max(1000))
    .transform((n) => n.toFixed(2))
    .default('1.0'),
  multipleLines: z.coerce.number().int().min(1).max(1000).default(1),
  broadcastEnabled: z.boolean().nullable().default(false),
  broadcastAudioId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  maxAbandonRate: z.union([z.number(), z.string()])
    .transform((v) => Number(v))
    .pipe(z.number().min(0).max(100))
    .transform((n) => n.toFixed(2))
    .default('3.0'),
  wrapUpSeconds: z.coerce.number().int().default(30),
  ringTimeoutSeconds: z.coerce.number().int().default(25),
  amdEnabled: z.boolean().nullable().default(false),
  amdTimeoutMs: z.coerce.number().int().default(3500),
  amdAction: z.string().default('hangup'),
  amdTransferTarget: z.string().nullable().optional(),
  recordingMode: z.enum(['all', 'none', 'on_demand']).default('all'),
  recordingFormat: z.enum(['wav', 'mp3', 'ogg']).default('wav'),
  byocRouting: z.string().default('platform'),
  byocCarrierId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  byocCarriers: z.array(z.object({
    carrierId: z.string().uuid(),
    priority: z.coerce.number().int().min(1),
  })).optional(),
  scheduledStart: z.preprocess((v) => v === '' ? null : v, z.coerce.date().nullable().optional()),
  scheduledEnd: z.preprocess((v) => v === '' ? null : v, z.coerce.date().nullable().optional()),
  dialingDays: z.array(z.string()).nullable().default(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
  dialingStartTime: z.string().default('09:00'),
  dialingEndTime: z.string().default('17:00'),
  scheduleTimezone: z.string().default('America/New_York'),
  maxCallsPerDay: z.coerce.number().int().default(0),
  maxAttemptsPerLead: z.coerce.number().int().default(3),
  retryDelayMinutes: z.coerce.number().int().default(60),
  retryFailedLeads: z.boolean().default(true),
  stirCertificateId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  respectLeadTimezone: z.boolean().nullable().default(true),
  pauseOnHolidays: z.boolean().nullable().default(true),
  dispositionRequired: z.boolean().nullable().default(true),
  enabledDispositions: z.array(z.string()).nullable().default([]),
  transferEnabled: z.boolean().nullable().default(false),
  transferType: z.string().default('blind'),
  transferDestType: z.string().default('external'),
  transferTarget: z.string().nullable().optional(),
  botQualifiedAction: z.string().nullable().optional(),
  botQualifiedTarget: z.string().nullable().optional(),
});

// Verify every picked lead list is usable by a campaign (not in "agents" mode).
async function validateCampaignLeadLists(tenantId: string, listIds: string[]): Promise<void> {
  if (listIds.length === 0) return;
  const picked = await db.select({ id: leadLists.id, name: leadLists.name, assignmentType: leadLists.assignmentType }).from(leadLists)
    .where(and(inArray(leadLists.id, listIds), eq(leadLists.tenantId, tenantId)));
  if (picked.length !== listIds.length) {
    const foundIds = new Set(picked.map((l) => l.id));
    const missing = listIds.filter((id) => !foundIds.has(id));
    throw new BadRequest(`Lead list(s) not found or not in this tenant: ${missing.join(', ')}`);
  }
  const blocked = picked.filter((l) => l.assignmentType === 'agents');
  if (blocked.length > 0) {
    throw new BadRequest(`Lead list(s) in agent-only mode can't be used by campaigns: ${blocked.map((l) => l.name).join(', ')}`);
  }
}

// List campaigns
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;

  const { cacheGet, cacheSet } = await import('../../lib/redis');
  const cacheKey = `campaigns:${tenantId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const raw = paginationSchema.extend({
    status: z.string().nullable().optional(),
    dialMode: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(campaigns.tenantId, tenantId)];
  if (raw.search) conditions.push(like(campaigns.name, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(campaigns.status, raw.status));
  if (raw.dialMode) conditions.push(eq(campaigns.dialMode, raw.dialMode));
  const where = and(...conditions);

  const leadCountSq = db.select({
    leadListId: leads.leadListId,
    cnt: count().as('cnt'),
  }).from(leads).groupBy(leads.leadListId).as('lead_counts');

  const callStatsSq = db.select({
    campaignId: calls.campaignId,
    dialed: count().as('dialed'),
    answered: sql<number>`count(*) filter (where ${calls.hangupCause} = 'NORMAL_CLEARING')`.as('answered'),
    abandoned: sql<number>`count(*) filter (where ${calls.hangupCause} IS NOT NULL AND ${calls.hangupCause} != 'NORMAL_CLEARING')`.as('abandoned'),
  }).from(calls).groupBy(calls.campaignId).as('call_stats');

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      campaign: campaigns,
      leads: leadCountSq.cnt,
      dialed: callStatsSq.dialed,
      answered: callStatsSq.answered,
      abandoned: callStatsSq.abandoned,
    }).from(campaigns)
      .leftJoin(leadCountSq, eq(campaigns.leadListId, leadCountSq.leadListId))
      .leftJoin(callStatsSq, eq(campaigns.id, callStatsSq.campaignId))
      .where(where).orderBy(desc(campaigns.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(campaigns).where(where),
  ]);

  const data = rows.map((r) => ({
    ...r.campaign,
    leads: Number(r.leads ?? 0),
    dialed: Number(r.dialed ?? 0),
    answered: Number(r.answered ?? 0),
    abandoned: Number(r.abandoned ?? 0),
  }));
  const result = paginatedResponse(data, Number(total), raw);
  await cacheSet(cacheKey, result, 30);
  return c.json(result);
});

// Live campaign dashboard — real-time dialling stats
router.get('/live-dashboard', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = z.object({ campaignId: z.string().uuid().optional() }).passthrough().parse(c.req.query());

  // Get campaigns — specific one, or all non-draft
  const campConditions: any[] = [eq(campaigns.tenantId, tenantId)];
  if (raw.campaignId) {
    campConditions.push(eq(campaigns.id, raw.campaignId));
  } else {
    campConditions.push(inArray(campaigns.status, ['running', 'paused', 'completed']));
  }
  const runningCampaigns = await db.select({ id: campaigns.id, name: campaigns.name, status: campaigns.status, dialMode: campaigns.dialMode, leadListId: campaigns.leadListId, leadListIds: campaigns.leadListIds, didGroupId: campaigns.didGroupId })
    .from(campaigns).where(and(...campConditions));

  const campaignIds = runningCampaigns.map((c) => c.id);
  // Collect all lead list IDs from both old single field and new array field
  const leadListIds = [...new Set(runningCampaigns.flatMap((c) => {
    const ids = (c.leadListIds as string[] | null)?.filter(Boolean) ?? [];
    return ids.length > 0 ? ids : (c.leadListId ? [c.leadListId] : []);
  }))];

  // Run all queries in parallel
  const [callStats, agentStats, leadStats, dispositionStats, amdStats, totalCallStats] = await Promise.all([
    // 1. Live call states
    campaignIds.length > 0
      ? db.select({
          status: calls.status,
          hasAgent: sql<boolean>`${calls.agentId} IS NOT NULL`,
          cnt: count(),
        }).from(calls)
          .where(and(inArray(calls.campaignId, campaignIds), inArray(calls.status, ['ringing', 'answered'])))
          .groupBy(calls.status, sql`${calls.agentId} IS NOT NULL`)
      : Promise.resolve([]),

    // 2. Agent list — filtered by campaign routing chain if a specific campaign is selected
    (async () => {
      const agentConditions: any[] = [
        eq(users.tenantId, tenantId),
        inArray(users.role, ['agent', 'supervisor']),
        isNull(users.deletedAt),
      ];

      // Resolve campaign → DID group → DIDs → queues → teams → agents
      if (raw.campaignId && runningCampaigns.length === 1) {
        const camp = runningCampaigns[0];
        const teamIds = new Set<string>();

        if (camp.didGroupId) {
          // Get DIDs in this group
          const groupDids = await db.select({ routeType: dids.routeType, routeTargetId: dids.routeTargetId })
            .from(dids).where(and(eq(dids.didGroupId, camp.didGroupId), eq(dids.tenantId, tenantId)));

          const queueIds = new Set<string>();
          const ivrIds = new Set<string>();

          for (const d of groupDids) {
            if (d.routeTargetId) {
              if (d.routeType === 'queue') queueIds.add(d.routeTargetId);
              else if (d.routeType === 'ivr') ivrIds.add(d.routeTargetId);
            }
          }

          // IVR → find queue transfers in IVR actions
          if (ivrIds.size > 0) {
            const ivrActions = await db.select({ targetId: ivrMenuActions.targetId, actionType: ivrMenuActions.actionType })
              .from(ivrMenuActions).where(and(
                inArray(ivrMenuActions.ivrMenuId, [...ivrIds]),
                eq(ivrMenuActions.actionType, 'transfer_queue'),
                isNotNull(ivrMenuActions.targetId),
              ));
            for (const a of ivrActions) {
              if (a.targetId) queueIds.add(a.targetId);
            }
          }

          // Queue → Team
          if (queueIds.size > 0) {
            const queueTeams = await db.select({ teamId: queues.teamId })
              .from(queues).where(inArray(queues.id, [...queueIds]));
            for (const q of queueTeams) {
              if (q.teamId) teamIds.add(q.teamId);
            }
          }
        }

        // Filter agents by resolved teams (if any found)
        if (teamIds.size > 0) {
          agentConditions.push(inArray(users.teamId, [...teamIds]));
        }
        // If no teams resolved, show all agents (campaign uses any available)
      }

      return db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        status: users.status,
        role: users.role,
        sipUsername: users.sipUsername,
      }).from(users).where(and(...agentConditions));
    })(),

    // 3. Lead progress
    leadListIds.length > 0
      ? db.select({
          status: leads.status,
          dnc: leads.dnc,
          cnt: count(),
        }).from(leads)
          .where(inArray(leads.leadListId, leadListIds))
          .groupBy(leads.status, leads.dnc)
      : Promise.resolve([]),

    // 4. Disposition breakdown
    campaignIds.length > 0
      ? db.select({
          disposition: calls.disposition,
          cnt: count(),
        }).from(calls)
          .where(and(
            inArray(calls.campaignId, campaignIds),
            eq(calls.status, 'completed'),
            isNotNull(calls.disposition),
          ))
          .groupBy(calls.disposition)
          .orderBy(desc(count()))
      : Promise.resolve([]),

    // 5. AMD filtered count
    campaignIds.length > 0
      ? db.select({ cnt: count() }).from(calls)
          .where(and(
            inArray(calls.campaignId, campaignIds),
            inArray(calls.amdResult, ['machine', 'voicemail']),
          ))
      : Promise.resolve([{ cnt: 0 }]),

    // 6. Total call summary (all time)
    campaignIds.length > 0
      ? db.select({
          totalCalls: count(),
          answered: sql<number>`count(*) filter (where ${calls.hangupCause} = 'NORMAL_CLEARING')`,
          failed: sql<number>`count(*) filter (where ${calls.hangupCause} IS NOT NULL AND ${calls.hangupCause} != 'NORMAL_CLEARING')`,
          totalDuration: sql<number>`coalesce(sum(${calls.durationSeconds}), 0)`,
          avgDuration: sql<number>`coalesce(avg(${calls.durationSeconds}) filter (where ${calls.durationSeconds} > 0), 0)`,
          amdCount: sql<number>`count(*) filter (where ${calls.amdResult} IN ('machine', 'voicemail'))`,
        }).from(calls)
          .where(and(inArray(calls.campaignId, campaignIds), eq(calls.status, 'completed')))
      : Promise.resolve([{ totalCalls: 0, answered: 0, failed: 0, totalDuration: 0, avgDuration: 0, amdCount: 0 }]),
  ]);

  // Process call stats
  let dialing = 0, ringing = 0, connected = 0, inIvr = 0;
  for (const r of callStats) {
    const n = Number(r.cnt);
    if (r.status === 'ringing') { dialing += n; ringing += n; }
    if (r.status === 'answered' && r.hasAgent) connected += n;
    if (r.status === 'answered' && !r.hasAgent) inIvr += n;
  }

  // Process agent stats
  const agentCounts: Record<string, number> = { available: 0, on_call: 0, wrap_up: 0, break: 0, offline: 0 };
  const agentTotal = agentStats.length;
  const agentList = agentStats.map((r) => {
    const st = r.status ?? 'offline';
    agentCounts[st] = (agentCounts[st] ?? 0) + 1;
    return { id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.sipUsername || 'Unknown', status: st, role: r.role };
  });

  // Process lead stats
  let pending = 0, called = 0, failed = 0, dncCount = 0, leadTotal = 0;
  for (const r of leadStats) {
    const n = Number(r.cnt);
    leadTotal += n;
    if (r.dnc) { dncCount += n; continue; }
    if (r.status === 'pending') pending += n;
    else if (r.status === 'called') called += n;
    else if (['failed', 'busy', 'no_answer'].includes(r.status ?? '')) failed += n;
  }

  // Process disposition stats
  const totalDisp = dispositionStats.reduce((s, r) => s + Number(r.cnt), 0);
  const dispositions = dispositionStats.map((r) => ({
    name: r.disposition ?? 'Unknown',
    count: Number(r.cnt),
    pct: totalDisp > 0 ? Math.round(Number(r.cnt) / totalDisp * 1000) / 10 : 0,
  }));

  return c.json({
    campaigns: runningCampaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, dialMode: c.dialMode })),
    summary: (() => {
      const total = Number(totalCallStats[0]?.totalCalls ?? 0);
      const ans = Number(totalCallStats[0]?.answered ?? 0);
      return {
        totalCalls: total,
        answered: ans,
        failed: Number(totalCallStats[0]?.failed ?? 0),
        amd: Number(totalCallStats[0]?.amdCount ?? 0),
        acd: Math.round(Number(totalCallStats[0]?.avgDuration ?? 0)),
        asr: total > 0 ? Math.round(ans / total * 1000) / 10 : 0,
      };
    })(),
    calling: { dialing, ringing, connected, inIvr, total: dialing + connected + inIvr },
    agents: {
      available: agentCounts.available ?? 0,
      onCall: agentCounts.on_call ?? 0,
      wrapUp: agentCounts.wrap_up ?? 0,
      onBreak: agentCounts.break ?? 0,
      offline: agentCounts.offline ?? 0,
      total: agentTotal,
    },
    agentList,
    leads: { pending, called, failed, dnc: dncCount, amdFiltered: Number(amdStats[0]?.cnt ?? 0), total: leadTotal },
    dispositions,
    timestamp: new Date().toISOString(),
  });
});

// Get single campaign
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(campaigns)
    .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)));
  if (!row) throw new NotFound('Campaign not found');
  return c.json(row);
});

// Get campaign live stats (carrier breakdown, active calls, ASR, ACD)
router.get('/:id/stats', async (c) => {
  const tenantId = c.get('tenantId')!;
  const campaignId = c.req.param('id');

  // Verify campaign exists
  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)));
  if (!campaign) throw new NotFound('Campaign not found');

  // Live calls (ringing + answered)
  const [{ activeCalls }] = await db.select({
    activeCalls: count(),
  }).from(calls).where(and(
    eq(calls.campaignId, campaignId),
    inArray(calls.status, ['ringing', 'answered']),
  ));

  // Carrier breakdown with ASR (Answer-Seizure Ratio) and ACD (Average Call Duration)
  const carrierStats = await db.select({
    carrier: calls.carrier,
    total: count(),
    answered: sql<number>`count(*) filter (where ${calls.hangupCause} = 'NORMAL_CLEARING')`,
    failed: sql<number>`count(*) filter (where ${calls.hangupCause} != 'NORMAL_CLEARING' AND ${calls.hangupCause} IS NOT NULL)`,
    avgDuration: sql<number>`coalesce(avg(${calls.durationSeconds}) filter (where ${calls.durationSeconds} > 0), 0)`,
    totalDuration: sql<number>`coalesce(sum(${calls.durationSeconds}), 0)`,
    avgMos: sql<number>`coalesce(avg(${calls.mos}::numeric) filter (where ${calls.mos} IS NOT NULL), 0)`,
  }).from(calls).where(and(
    eq(calls.campaignId, campaignId),
    eq(calls.status, 'completed'),
  )).groupBy(calls.carrier);

  // Hangup cause breakdown
  const hangupStats = await db.select({
    cause: calls.hangupCause,
    total: count(),
  }).from(calls).where(and(
    eq(calls.campaignId, campaignId),
    eq(calls.status, 'completed'),
  )).groupBy(calls.hangupCause).orderBy(desc(count()));

  // Agent performance for this campaign
  const agentStats = await db.select({
    agentId: calls.agentId,
    firstName: sql<string>`min(${users.firstName})`,
    lastName: sql<string>`min(${users.lastName})`,
    total: count(),
    answered: sql<number>`count(*) filter (where ${calls.hangupCause} = 'NORMAL_CLEARING')`,
    avgDuration: sql<number>`coalesce(avg(${calls.durationSeconds}) filter (where ${calls.durationSeconds} > 0), 0)`,
    agentStatus: sql<string>`min(${users.status})`,
  }).from(calls)
    .leftJoin(users, eq(calls.agentId, users.id))
    .where(eq(calls.campaignId, campaignId))
    .groupBy(calls.agentId);

  return c.json({
    activeCalls: Number(activeCalls),
    carriers: carrierStats.map((r) => ({
      name: r.carrier || 'Unknown',
      total: Number(r.total),
      answered: Number(r.answered),
      failed: Number(r.failed),
      asr: Number(r.total) > 0 ? Math.round(Number(r.answered) / Number(r.total) * 100 * 10) / 10 : 0,
      acd: Math.round(Number(r.avgDuration)),
      totalMinutes: Math.round(Number(r.totalDuration) / 60),
      avgMos: Math.round(Number(r.avgMos) * 100) / 100,
    })),
    hangupCauses: hangupStats.map((r) => ({
      cause: r.cause || 'Unknown',
      count: Number(r.total),
    })),
    agents: agentStats.map((r) => ({
      id: r.agentId,
      name: [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Unknown',
      status: r.agentStatus || 'offline',
      calls: Number(r.total),
      answered: Number(r.answered),
      avgDuration: Math.round(Number(r.avgDuration)),
    })),
  });
});

// Get lead breakdown for rechain modal — dispositions + statuses with counts
router.get('/:id/lead-breakdown', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const campaignId = c.req.param('id');

  const [campaign] = await db.select({ id: campaigns.id, leadListId: campaigns.leadListId, enabledDispositions: campaigns.enabledDispositions })
    .from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)));
  if (!campaign) throw new NotFound('Campaign not found');
  if (!campaign.leadListId) return c.json({ dispositions: [], statuses: [], enabledDispositions: [] });

  const [dispoBreakdown, statusBreakdown] = await Promise.all([
    // Leads grouped by last_disposition (only non-null, non-pending)
    db.select({
      disposition: leads.lastDisposition,
      status: leads.status,
      cnt: count(),
    }).from(leads).where(and(
      eq(leads.leadListId, campaign.leadListId),
      eq(leads.tenantId, tenantId),
      isNotNull(leads.lastDisposition),
      sql`${leads.status} != 'pending'`,
    )).groupBy(leads.lastDisposition, leads.status).orderBy(desc(count())),

    // Leads grouped by status (non-pending, no disposition)
    db.select({
      status: leads.status,
      cnt: count(),
    }).from(leads).where(and(
      eq(leads.leadListId, campaign.leadListId),
      eq(leads.tenantId, tenantId),
      isNull(leads.lastDisposition),
      sql`${leads.status} != 'pending'`,
    )).groupBy(leads.status).orderBy(desc(count())),
  ]);

  return c.json({
    dispositions: dispoBreakdown.map((r) => ({
      disposition: r.disposition,
      status: r.status,
      count: Number(r.cnt),
    })),
    statuses: statusBreakdown.map((r) => ({
      status: r.status,
      count: Number(r.cnt),
    })),
    enabledDispositions: campaign.enabledDispositions ?? [],
  });
});

// Rechain — reset leads with selected dispositions/statuses back to pending
router.post('/:id/rechain', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const campaignId = c.req.param('id');
  const body = z.object({
    dispositions: z.array(z.string()).default([]),
    statuses: z.array(z.string()).default([]),
  }).parse(await c.req.json());

  if (body.dispositions.length === 0 && body.statuses.length === 0) {
    throw new BadRequest('Select at least one disposition or status');
  }

  const [campaign] = await db.select({ id: campaigns.id, leadListId: campaigns.leadListId })
    .from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)));
  if (!campaign) throw new NotFound('Campaign not found');
  if (!campaign.leadListId) throw new BadRequest('Campaign has no lead list');

  let rechained = 0;

  // Reset leads by disposition
  if (body.dispositions.length > 0) {
    const result = await db.update(leads).set({
      status: 'pending', attempts: 0, lastAttemptAt: null, nextAttemptAt: null, lastDisposition: null,
    }).where(and(
      eq(leads.leadListId, campaign.leadListId),
      eq(leads.tenantId, tenantId),
      inArray(leads.lastDisposition, body.dispositions),
    ));
    rechained += (result as any).rowCount ?? 0;
  }

  // Reset leads by status (those without dispositions)
  if (body.statuses.length > 0) {
    const result = await db.update(leads).set({
      status: 'pending', attempts: 0, lastAttemptAt: null, nextAttemptAt: null,
    }).where(and(
      eq(leads.leadListId, campaign.leadListId),
      eq(leads.tenantId, tenantId),
      isNull(leads.lastDisposition),
      inArray(leads.status, body.statuses),
    ));
    rechained += (result as any).rowCount ?? 0;
  }

  return c.json({ ok: true, rechained });
});

// Test call — verify complete call flow using campaign's DID routing (DID → IVR → Queue → Agent)
router.post('/:id/test-call', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const campaignId = c.req.param('id');
  const body = z.object({ phoneNumber: z.string().min(7) }).parse(await c.req.json());

  const [campaign] = await db.select().from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)));
  if (!campaign) throw new NotFound('Campaign not found');

  // Resolve caller ID from campaign DID group
  let callerId = 'treepbx';
  let didId: string | null = null;
  let didNumber: string | null = null;
  if (campaign.didGroupId) {
    const { dids } = await import('../../db/schema');
    const [did] = await db.select({ id: dids.id, number: dids.number }).from(dids)
      .where(and(eq(dids.didGroupId, campaign.didGroupId), eq(dids.active, true))).limit(1);
    if (did) { callerId = did.number; didId = did.id; didNumber = did.number; }
  }

  // Resolve gateway with failover
  let gateways: string[] = [];
  let carrierName: string | null = null;
  if (campaign.byocCarrierId) {
    const { byocCarriers } = await import('../../db/schema');
    const [carrier] = await db.select({ name: byocCarriers.name }).from(byocCarriers)
      .where(eq(byocCarriers.id, campaign.byocCarrierId));
    if (carrier) { gateways.push(carrier.name); carrierName = carrier.name; }
  }
  // Add platform carriers as failover
  const { getOutboundGateways } = await import('../../esl/commands');
  const platformGws = await getOutboundGateways();
  for (const gw of platformGws) {
    if (!gateways.includes(gw)) gateways.push(gw);
  }
  if (gateways.length === 0) gateways.push(process.env.FS_DEFAULT_GATEWAY ?? 'OTB2');

  // Create call record
  const [call] = await db.insert(calls).values({
    tenantId, campaignId, didId,
    direction: 'outbound',
    callerId,
    callerName: campaign.name,
    calleeNumber: body.phoneNumber,
    calleeName: 'Test Call',
    status: 'ringing',
    startedAt: new Date(),
    carrier: carrierName,
  }).returning();

  const { eslClient } = await import('../../esl/client');
  if (!eslClient.isConnected()) {
    await db.update(calls).set({ status: 'failed', endedAt: new Date(), hangupCause: 'FREESWITCH_UNAVAILABLE' }).where(eq(calls.id, call.id));
    throw new BadRequest('FreeSWITCH not connected');
  }

  // Resolve full route: DID → IVR → Queue → Agent extension
  let bridgeTarget: string | null = null;
  let routeInfo = 'park (no route configured)';
  if (didId) {
    const { dids: didsTable, ivrMenus, queues } = await import('../../db/schema');
    const [did] = await db.select({ routeType: didsTable.routeType, routeTargetId: didsTable.routeTargetId })
      .from(didsTable).where(eq(didsTable.id, didId));

    if (did?.routeType === 'queue' && did.routeTargetId) {
      // DID → Queue: find an agent in the queue
      const [q] = await db.select({ name: queues.name, teamId: queues.teamId }).from(queues).where(eq(queues.id, did.routeTargetId));
      if (q?.teamId) {
        const [qAgent] = await db.select({ sipUsername: users.sipUsername }).from(users)
          .where(and(eq(users.teamId, q.teamId), eq(users.status, 'available'), isNull(users.deletedAt))).limit(1);
        if (qAgent?.sipUsername) { bridgeTarget = `user/${qAgent.sipUsername}`; routeInfo = `DID → Queue(${q.name}) → ${qAgent.sipUsername}`; }
        else { routeInfo = `DID → Queue(${q.name}) → no available agent`; }
      }
    } else if (did?.routeType === 'ivr' && did.routeTargetId) {
      // DID → IVR → check timeout target (queue)
      const [ivr] = await db.select({ name: ivrMenus.name, timeoutAction: ivrMenus.timeoutAction, timeoutTargetId: ivrMenus.timeoutTargetId })
        .from(ivrMenus).where(eq(ivrMenus.id, did.routeTargetId));
      if (ivr?.timeoutAction === 'transfer_queue' && ivr.timeoutTargetId) {
        const [q] = await db.select({ name: queues.name, teamId: queues.teamId }).from(queues).where(eq(queues.id, ivr.timeoutTargetId));
        if (q?.teamId) {
          const [qAgent] = await db.select({ sipUsername: users.sipUsername }).from(users)
            .where(and(eq(users.teamId, q.teamId), eq(users.status, 'available'), isNull(users.deletedAt))).limit(1);
          if (qAgent?.sipUsername) { bridgeTarget = `user/${qAgent.sipUsername}`; routeInfo = `DID → IVR(${ivr.name}) → Queue(${q.name}) → ${qAgent.sipUsername}`; }
          else {
            // No agent in queue team — try any available agent
            const [anyAgent] = await db.select({ sipUsername: users.sipUsername }).from(users)
              .where(and(eq(users.tenantId, tenantId), inArray(users.role, ['agent', 'supervisor']), isNull(users.deletedAt), sql`${users.sipUsername} IS NOT NULL`)).limit(1);
            if (anyAgent?.sipUsername) { bridgeTarget = `user/${anyAgent.sipUsername}`; routeInfo = `DID → IVR(${ivr.name}) → Queue(${q.name}) → ${anyAgent.sipUsername} (fallback)`; }
            else { routeInfo = `DID → IVR(${ivr.name}) → Queue(${q.name}) → no available agent`; }
          }
        }
      } else if (ivr) {
        routeInfo = `DID → IVR(${ivr.name}) → timeout action: ${ivr.timeoutAction}`;
      }
    }
  }

  const safeName = campaign.name.replace(/[^a-zA-Z0-9 _-]/g, '');
  const vars = [
    `origination_caller_id_number=${callerId}`,
    `origination_caller_id_name='${safeName}'`,
    `originate_timeout=${campaign.ringTimeoutSeconds ?? 25}`,
    `treepbx_call_id=${call.id}`,
    `treepbx_tenant_id=${tenantId}`,
  ].join(',');

  const action = bridgeTarget ? `&bridge(${bridgeTarget})` : '&park()';
  const dialString = gateways.map(gw => `sofia/gateway/${gw}/${body.phoneNumber}`).join('|');
  const cmd = `originate {${vars}}${dialString} ${action}`;
  logger.info({ cmd, bridgeTarget, routeInfo, gateways }, '[TestCall] originate command');
  eslClient.bgapi(cmd);

  return c.json({ ok: true, callId: call.id, phoneNumber: body.phoneNumber, route: routeInfo });
});

// Create campaign
router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const body = campaignSchema.parse(await c.req.json());

  // Check duplicate campaign name within tenant
  const [dup] = await db.select({ id: campaigns.id }).from(campaigns)
    .where(and(eq(campaigns.name, body.name), eq(campaigns.tenantId, tenantId)));
  if (dup) throw new BadRequest('Campaign name already exists');

  // Sync leadListId with leadListIds for backwards compat
  const insertData = { ...body };
  if (insertData.leadListIds?.length) {
    insertData.leadListId = insertData.leadListIds[0];
  } else if (insertData.leadListId) {
    insertData.leadListIds = [insertData.leadListId];
  }

  await validateCampaignLeadLists(tenantId, insertData.leadListIds ?? []);

  const [row] = await db.insert(campaigns).values({
    ...insertData,
    tenantId,
    createdBy: userId,
    status: 'draft',
  }).returning();
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`campaigns:${tenantId}*`);
  return c.json(row, 201);
});

// Update campaign
router.put('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = campaignSchema.partial().parse(await c.req.json());

  // Check duplicate campaign name within tenant (exclude self)
  if (body.name) {
    const [dup] = await db.select({ id: campaigns.id }).from(campaigns)
      .where(and(eq(campaigns.name, body.name), eq(campaigns.tenantId, tenantId), sql`${campaigns.id} != ${c.req.param('id')}`));
    if (dup) throw new BadRequest('Campaign name already exists');
  }

  // Sync leadListId with leadListIds
  const updateData = { ...body };
  if (updateData.leadListIds?.length) {
    updateData.leadListId = updateData.leadListIds[0];
  } else if (updateData.leadListId) {
    updateData.leadListIds = [updateData.leadListId];
  }

  if (updateData.leadListIds !== undefined) {
    await validateCampaignLeadLists(tenantId, updateData.leadListIds ?? []);
  }

  const [row] = await db.update(campaigns)
    .set({ ...updateData, updatedAt: new Date() })
    .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Campaign not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`campaigns:${tenantId}*`);

  // Sync dialer state if status field was touched. Without this, saving the
  // form with status='running' silently leaves the dialer stopped because
  // only the dedicated /status route was wiring start/stop before.
  if ('status' in updateData) {
    const { startCampaignDialer, stopCampaignDialer } = await import('../../esl/dialer');
    if (row.status === 'running' || row.status === 'active') {
      startCampaignDialer(row.id);
    } else {
      stopCampaignDialer(row.id);
    }
  }

  return c.json(row);
});

// Delete campaign
router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const campaignId = c.req.param('id');
  const [row] = await db.delete(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Campaign not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`campaigns:${tenantId}*`);
  return c.json({ ok: true });
});

// Clone campaign
router.post('/:id/clone', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const [original] = await db.select().from(campaigns)
    .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)));
  if (!original) throw new NotFound('Campaign not found');

  const { id, createdAt, updatedAt, ...rest } = original;
  const [cloned] = await db.insert(campaigns).values({
    ...rest,
    name: `${original.name} (Copy)`,
    status: 'draft',
    createdBy: userId,
  }).returning();

  return c.json(cloned, 201);
});

// Update campaign status
router.put('/:id/status', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ status: z.enum(['running', 'active', 'paused', 'draft', 'completed']) }).passthrough().parse(await c.req.json());
  const newStatus = body.status === 'active' ? 'running' : body.status;

  const [existing] = await db.select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns).where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)));
  if (!existing) throw new NotFound('Campaign not found');

  const [row] = await db.update(campaigns)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(campaigns.id, existing.id))
    .returning();

  // Start/stop dialer based on status
  const { startCampaignDialer, stopCampaignDialer } = await import('../../esl/dialer');
  if (newStatus === 'running') {
    startCampaignDialer(existing.id);
  } else {
    stopCampaignDialer(existing.id);
  }

  return c.json(row);
});

export default router;
