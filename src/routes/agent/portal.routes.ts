import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, sql, gte } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, calls, scheduleEvents, agentSessions } from '../../db/schema';
import { NotFound } from '../../lib/errors';

const router = new Hono();

// GET /profile — agent profile + team info
router.get('/profile', async (c) => {
  const userId = c.get('user').sub;
  const tenantId = c.get('tenantId')!;
  const [user] = await db.select().from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .limit(1);
  if (!user) throw new NotFound('User not found');
  return c.json({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    status: user.status,
    teamId: user.teamId,
    sipUsername: user.sipUsername,
    sipDomain: user.sipDomain,
    settings: user.settings,
  });
});

// GET /stats/today — today's call stats
router.get('/stats/today', async (c) => {
  const userId = c.get('user').sub;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [stats] = await db
    .select({
      totalCalls: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
      avgDuration: sql<number>`coalesce(avg(${calls.durationSeconds}), 0)::int`,
      totalTalkTime: sql<number>`coalesce(sum(${calls.talkTimeSeconds}), 0)::int`,
    })
    .from(calls)
    .where(and(eq(calls.agentId, userId), gte(calls.startedAt, today)));

  return c.json(stats);
});

// GET /schedule/upcoming — next few schedule events
router.get('/schedule/upcoming', async (c) => {
  const userId = c.get('user').sub;
  const now = new Date();

  const events = await db
    .select()
    .from(scheduleEvents)
    .where(and(eq(scheduleEvents.userId, userId), gte(scheduleEvents.startTime, now)))
    .orderBy(scheduleEvents.startTime)
    .limit(5);

  return c.json(events);
});

const statusSchema = z.object({ status: z.enum(['available', 'on_call', 'wrap_up', 'break', 'offline']) });

// PUT /status — update agent status
router.put('/status', async (c) => {
  const userId = c.get('user').sub;
  const { status } = statusSchema.parse(await c.req.json());

  await db.update(users).set({
    status,
    statusChangedAt: new Date(),
  }).where(eq(users.id, userId));

  return c.json({ ok: true });
});

export default router;
