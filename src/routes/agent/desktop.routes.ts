import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, gte, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, leads, users, campaigns, scripts, agentLeadLists, leadLists, followUpTodos } from '../../db/schema';
import { count, asc } from 'drizzle-orm';
import { logger } from '../../lib/logger';

const router = new Hono();

// GET /call-history — recent calls for this agent or all calls for tenant admin
router.get('/call-history', async (c) => {
  const userId = c.get('user').sub;
  const tenantId = c.get('tenantId')!;
  const userRole = c.get('user').role;

  // Agent desktop always shows only the logged-in user's calls
  // (tenant-wide call history is on the Call Trace page, not here)

  // Agent sees only calls assigned to their user ID
  const history = await db
    .select({
      id: calls.id, direction: calls.direction, callerId: calls.callerId,
      callerName: calls.callerName, calleeNumber: calls.calleeNumber, calleeName: calls.calleeName,
      status: calls.status, disposition: calls.disposition,
      durationSeconds: calls.durationSeconds, talkTimeSeconds: calls.talkTimeSeconds, startedAt: calls.startedAt,
    })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.agentId, userId)))
    .orderBy(desc(calls.startedAt))
    .limit(50);

  return c.json({ data: history });
});

// GET /stats/today
router.get('/stats/today', async (c) => {
  const userId = c.get('user').sub;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [stats] = await db
    .select({
      totalCalls: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
      avgDuration: sql<number>`coalesce(avg(${calls.durationSeconds}), 0)::int`,
      talkTime: sql<number>`coalesce(sum(${calls.talkTimeSeconds}), 0)::int`,
    })
    .from(calls)
    .where(and(eq(calls.agentId, userId), gte(calls.startedAt, today)));

  const avgMin = Math.floor(Number(stats.avgDuration) / 60);
  const avgSec = Number(stats.avgDuration) % 60;
  return c.json({
    ...stats,
    avgDuration: `${avgMin}m ${avgSec}s`,
    totalTalkTime: `${Math.floor(Number(stats.talkTime) / 60)}m`,
  });
});

// GET /lead/:id — lead info for current call
router.get('/lead/:id', async (c) => {
  const leadId = c.req.param('id');
  const tenantId = c.get('tenantId')!;
  const [lead] = await db.select().from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)))
    .limit(1);
  if (!lead) return c.json(null);
  return c.json(lead);
});

// GET /call/lead — lead info for agent's current/recent call
router.get('/call/lead', async (c) => {
  const userId = c.get('user').sub;
  const tenantId = c.get('tenantId')!;
  const { or, like } = await import('drizzle-orm');

  // Find agent's most recent call (within last 5 min)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const [activeCall] = await db.select({ leadId: calls.leadId, callerId: calls.callerId, calleeNumber: calls.calleeNumber })
    .from(calls)
    .where(and(eq(calls.agentId, userId), gte(calls.startedAt, fiveMinAgo)))
    .orderBy(desc(calls.startedAt))
    .limit(1);

  if (!activeCall) return c.json(null);

  // If call has a leadId, use it directly
  if (activeCall.leadId) {
    const [lead] = await db.select().from(leads)
      .where(and(eq(leads.id, activeCall.leadId), eq(leads.tenantId, tenantId)));
    return c.json(lead || null);
  }

  // Otherwise, look up lead by phone number match (caller or callee)
  const phoneNumbers = [activeCall.callerId, activeCall.calleeNumber].filter(Boolean);
  if (phoneNumbers.length === 0) return c.json(null);

  const conditions = phoneNumbers.map((p) => like(leads.phone, `%${p!.replace(/\D/g, '').slice(-10)}%`));
  const [lead] = await db.select().from(leads)
    .where(and(eq(leads.tenantId, tenantId), or(...conditions)))
    .limit(1);

  return c.json(lead || null);
});

// GET /call/script — script steps for agent's current active call's campaign
router.get('/call/script', async (c) => {
  const userId = c.get('user').sub;
  const tenantId = c.get('tenantId')!;

  // Find agent's active or recent call and its campaign
  const fiveMinAgo2 = new Date(Date.now() - 5 * 60 * 1000);
  const [activeCall] = await db.select({ campaignId: calls.campaignId })
    .from(calls)
    .where(and(eq(calls.agentId, userId), gte(calls.startedAt, fiveMinAgo2)))
    .orderBy(desc(calls.startedAt))
    .limit(1);

  if (!activeCall?.campaignId) return c.json({ data: [] });

  // Find campaign's script
  const [campaign] = await db.select({ scriptId: campaigns.scriptId })
    .from(campaigns)
    .where(and(eq(campaigns.id, activeCall.campaignId), eq(campaigns.tenantId, tenantId)));

  if (!campaign?.scriptId) return c.json({ data: [] });

  const [script] = await db.select().from(scripts)
    .where(eq(scripts.id, campaign.scriptId));

  return c.json({ data: script?.steps || [] });
});

// POST /call/answer — answer incoming call (ESL stub)
router.post('/call/answer', async (c) => {
  return c.json({ ok: true, action: 'answer' });
});

// POST /call/reject
router.post('/call/reject', async (c) => {
  return c.json({ ok: true, action: 'reject' });
});

// POST /call/hangup
router.post('/call/hangup', async (c) => {
  return c.json({ ok: true, action: 'hangup' });
});

// POST /call/mute
router.post('/call/mute', async (c) => {
  return c.json({ ok: true, action: 'mute' });
});

// POST /call/unmute
router.post('/call/unmute', async (c) => {
  return c.json({ ok: true, action: 'unmute' });
});

// POST /call/hold
router.post('/call/hold', async (c) => {
  return c.json({ ok: true, action: 'hold' });
});

// POST /call/resume
router.post('/call/resume', async (c) => {
  return c.json({ ok: true, action: 'resume' });
});

// Blind transfer the agent's currently-active call to another agent or an
// external number. Looks up the most recent ringing/answered call for this
// agent (must have a FreeSWITCH UUID), then issues uuid_transfer via ESL.
//
// target shape:
//   agent:<userId>      → bridge to that agent's SIP user via 'user/<sipUsername>'
//   external:<number>   → bridge out to PSTN via the configured default gateway
//
// IVR transfer is intentionally not supported here — the IVR menus exist in
// the DB but no FS dialplan/Lua executes them, so a transfer there would
// drop the call. UI surfaces this as a disabled option.
router.post('/call/transfer', async (c) => {
  const body = z.object({
    target: z.string().min(1),
    type: z.enum(['blind', 'attended']).default('blind'),
  }).parse(await c.req.json());

  if (body.type === 'attended') {
    return c.json({ error: 'Attended transfer not yet implemented — use blind for now.' }, 400);
  }

  const userId = c.get('user').sub;
  const tenantId = c.get('tenantId')!;

  // Find the agent's most recent active call (must have an FS UUID — without
  // that there's nothing to transfer).
  const [call] = await db.select({
    id: calls.id,
    freeswitchUuid: calls.freeswitchUuid,
  }).from(calls)
    .where(and(
      eq(calls.agentId, userId),
      eq(calls.tenantId, tenantId),
      inArray(calls.status, ['ringing', 'answered']),
    ))
    .orderBy(desc(calls.startedAt))
    .limit(1);
  if (!call) return c.json({ error: 'No active call to transfer' }, 404);
  if (!call.freeswitchUuid) {
    return c.json({ error: 'Call is still connecting — wait until it is answered before transferring' }, 409);
  }

  // Resolve target → FS dial string
  let dialString: string;
  let targetLabel: string;
  if (body.target.startsWith('agent:')) {
    const agentId = body.target.slice('agent:'.length);
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) {
      return c.json({ error: 'Invalid agent target' }, 400);
    }
    const [agent] = await db.select({ sipUsername: users.sipUsername })
      .from(users)
      .where(and(eq(users.id, agentId), eq(users.tenantId, tenantId)));
    if (!agent?.sipUsername) {
      return c.json({ error: 'Target agent has no SIP extension' }, 400);
    }
    dialString = `user/${agent.sipUsername}`;
    targetLabel = `agent:${agent.sipUsername}`;
  } else if (body.target.startsWith('external:')) {
    const raw = body.target.slice('external:'.length).trim();
    const digits = raw.replace(/[^\d+]/g, '');
    if (!/^\+?\d{4,}$/.test(digits)) {
      return c.json({ error: 'Invalid external number' }, 400);
    }
    const gateway = process.env.FS_DEFAULT_GATEWAY ?? 'OTB2';
    dialString = `sofia/gateway/${gateway}/${digits}`;
    targetLabel = `external:${digits}`;
  } else {
    return c.json({ error: 'Unsupported transfer target — use agent:<id> or external:<number>' }, 400);
  }

  // Blind transfer: hand the live channel off via inline dialplan to bridge
  // it to the new destination. The caller stays connected; the agent's leg
  // gets dropped because they're no longer in the bridge.
  const { eslClient } = await import('../../esl/client');
  if (!eslClient.isConnected()) {
    return c.json({ error: 'FreeSWITCH ESL not connected' }, 503);
  }
  const fsCmd = `uuid_transfer ${call.freeswitchUuid} 'bridge:${dialString}' inline`;
  eslClient.api(fsCmd);
  logger.info({ callId: call.id, fsCmd, target: targetLabel }, '[transfer] issued');

  await db.update(calls).set({
    disposition: `transferred:${targetLabel}`,
  }).where(eq(calls.id, call.id));

  // Free the agent — they're no longer on this call after the transfer
  await db.update(users).set({ status: 'available', statusChangedAt: new Date() })
    .where(eq(users.id, userId));

  return c.json({ ok: true, callId: call.id, target: targetLabel });
});

// POST /call/disposition — wrap-up
const dispositionSchema = z.object({
  callId: z.string().uuid(),
  disposition: z.string(),
  note: z.string().nullable().optional(),
  callbackTime: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
});

router.post('/call/disposition', async (c) => {
  const body = dispositionSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;

  const [call] = await db.update(calls).set({
    disposition: body.disposition,
    status: 'completed',
    endedAt: new Date(),
  }).where(and(eq(calls.id, body.callId), eq(calls.tenantId, tenantId)))
    .returning({ leadId: calls.leadId, calleeNumber: calls.calleeNumber, calleeName: calls.calleeName });

  if (call?.leadId) {
    // Append wrap-up note + summary into lead notes (timestamped) so the
    // next agent who opens this lead sees the prior context.
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const blob = [body.note, body.summary].filter((s) => s && s.trim()).join('\n');
    await db.update(leads).set({
      lastDisposition: body.disposition,
      ...(blob && { notes: sql`COALESCE(${leads.notes} || E'\n\n', '') || ${`[${ts}] ${body.disposition}\n${blob}`}` }),
    }).where(eq(leads.id, call.leadId));
  }

  // Callback Scheduled disposition + callbackTime → follow-up todo
  if (body.callbackTime && call?.leadId) {
    const due = new Date(body.callbackTime);
    if (!isNaN(due.getTime())) {
      await db.insert(followUpTodos).values({
        tenantId,
        agentId: userId,
        leadId: call.leadId,
        leadName: call.calleeName,
        leadPhone: call.calleeNumber,
        reason: body.disposition,
        dueDate: due,
      });
    }
  }

  await db.update(users).set({
    status: 'available',
    statusChangedAt: new Date(),
  }).where(eq(users.id, userId));

  return c.json({ ok: true });
});

// POST /call/dial — outbound call (ESL stub)
router.post('/call/dial', async (c) => {
  const { number } = await c.req.json<{ number: string }>();
  return c.json({ ok: true, action: 'dial', number });
});

// GET /my-lists — agent's assigned lead lists with lead counts
router.get('/my-lists', async (c) => {
  const user = c.get('user');
  const agentId = user.sub;

  const assigned = await db.select({
    leadListId: agentLeadLists.leadListId,
    name: leadLists.name,
    description: leadLists.description,
    status: leadLists.status,
  }).from(agentLeadLists)
    .innerJoin(leadLists, eq(agentLeadLists.leadListId, leadLists.id))
    .where(eq(agentLeadLists.agentId, agentId));

  // Get lead counts per list
  const listIds = assigned.map((a) => a.leadListId);
  const counts = listIds.length > 0
    ? await db.select({ leadListId: leads.leadListId, total: count(), pending: sql<number>`count(*) filter (where ${leads.status} = 'pending')` })
        .from(leads).where(inArray(leads.leadListId, listIds)).groupBy(leads.leadListId)
    : [];
  const countMap = Object.fromEntries(counts.map((c) => [c.leadListId, { total: Number(c.total), pending: Number(c.pending) }]));

  const data = assigned.map((a) => ({
    ...a,
    id: a.leadListId,
    leadCount: countMap[a.leadListId]?.total ?? 0,
    pendingCount: countMap[a.leadListId]?.pending ?? 0,
  }));

  return c.json({ data });
});

// GET /my-lists/:listId/leads — paginated leads from an assigned list
router.get('/my-lists/:listId/leads', async (c) => {
  const user = c.get('user');
  const agentId = user.sub;
  const listId = c.req.param('listId');

  // Verify agent is assigned to this list
  const [assignment] = await db.select({ leadListId: agentLeadLists.leadListId })
    .from(agentLeadLists).where(and(eq(agentLeadLists.agentId, agentId), eq(agentLeadLists.leadListId, listId)));
  if (!assignment) return c.json({ data: [], total: 0 });

  const raw = z.object({
    page: z.coerce.number().default(1),
    limit: z.coerce.number().default(25),
    search: z.string().optional(),
  }).parse(c.req.query());

  const conditions: any[] = [eq(leads.leadListId, listId)];
  if (raw.search) {
    conditions.push(sql`(${leads.phone} ILIKE ${'%' + raw.search + '%'} OR ${leads.firstName} ILIKE ${'%' + raw.search + '%'} OR ${leads.lastName} ILIKE ${'%' + raw.search + '%'} OR ${leads.company} ILIKE ${'%' + raw.search + '%'})`);
  }

  const offset = (raw.page - 1) * raw.limit;
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(leads).where(and(...conditions))
      .orderBy(sql`CASE WHEN ${leads.status} = 'pending' THEN 0 ELSE 1 END`, asc(leads.createdAt))
      .limit(raw.limit).offset(offset),
    db.select({ total: count() }).from(leads).where(and(...conditions)),
  ]);

  return c.json({ data: rows, total: Number(total), page: raw.page, limit: raw.limit });
});

export default router;
