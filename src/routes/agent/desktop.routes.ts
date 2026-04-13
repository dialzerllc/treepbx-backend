import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, leads, users } from '../../db/schema';

const router = new Hono();

// GET /call-history — recent calls for this agent
router.get('/call-history', async (c) => {
  const userId = c.get('user').sub;

  const history = await db
    .select({
      id: calls.id,
      direction: calls.direction,
      callerId: calls.callerId,
      callerName: calls.callerName,
      calleeNumber: calls.calleeNumber,
      status: calls.status,
      disposition: calls.disposition,
      durationSeconds: calls.durationSeconds,
      startedAt: calls.startedAt,
    })
    .from(calls)
    .where(eq(calls.agentId, userId))
    .orderBy(desc(calls.startedAt))
    .limit(50);

  return c.json(history);
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

  return c.json(stats);
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

// POST /call/transfer
router.post('/call/transfer', async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true, action: 'transfer', target: body.target });
});

// POST /call/disposition — wrap-up
const dispositionSchema = z.object({
  callId: z.string().uuid(),
  disposition: z.string(),
  note: z.string().optional(),
  callbackTime: z.string().optional(),
  summary: z.string().optional(),
});

router.post('/call/disposition', async (c) => {
  const body = dispositionSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId')!;

  await db.update(calls).set({
    disposition: body.disposition,
    status: 'completed',
    endedAt: new Date(),
  }).where(and(eq(calls.id, body.callId), eq(calls.tenantId, tenantId)));

  // Update agent status back to available
  const userId = c.get('user').sub;
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

export default router;
