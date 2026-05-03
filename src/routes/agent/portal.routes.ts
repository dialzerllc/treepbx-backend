import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, sql, gte } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { db } from '../../db/client';
import { users, calls, scheduleEvents, agentSessions, agentDids, dids } from '../../db/schema';
import { NotFound } from '../../lib/errors';
import { logger } from '../../lib/logger';

const router = new Hono();

// TURN long-term credentials (RFC 5389 §10.2 + draft-uberti-rtcweb-turn-rest).
// Username is "<expiry-unix>:<userId>", password is HMAC-SHA1 of that username
// with the shared secret from /etc/turnserver.conf. Coturn validates without
// any DB lookup — credentials are good until expiry.
let _turnSecret: string | null = null;
function getTurnSecret(): string | null {
  if (_turnSecret !== null) return _turnSecret || null;
  try {
    const raw = readFileSync('/opt/tpbx/secrets/turn_secret', 'utf8').trim();
    _turnSecret = raw.replace(/^SECRET=/, '');
    return _turnSecret;
  } catch (err) {
    logger.warn({ err }, '[turn] secret file missing — TURN endpoint will return public STUN only');
    _turnSecret = '';
    return null;
  }
}

router.get('/turn-credentials', (c) => {
  const userId = c.get('user').sub;
  const secret = getTurnSecret();
  // Always return at least Google STUN as a fallback so WebRTC still has
  // candidates if our TURN is down or the secret isn't deployed yet.
  const iceServers: any[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (secret) {
    const ttlSec = 8 * 3600;
    const expiry = Math.floor(Date.now() / 1000) + ttlSec;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: ['stun:app.treepbx.com:3478'], username, credential });
    iceServers.push({ urls: ['turn:app.treepbx.com:3478?transport=udp'], username, credential });
    iceServers.push({ urls: ['turn:app.treepbx.com:3478?transport=tcp'], username, credential });
  }
  return c.json({ iceServers, ttl: 8 * 3600 });
});

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

  const avgMin = Math.floor(Number(stats.avgDuration) / 60);
  const avgSec = Number(stats.avgDuration) % 60;
  return c.json({
    ...stats,
    avgDuration: `${avgMin}m ${avgSec}s`,
    totalTalkTime: `${Math.floor(Number(stats.totalTalkTime) / 60)}m`,
  });
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

// GET /dids — agent's assigned DIDs for caller ID selection
router.get('/dids', async (c) => {
  const userId = c.get('user').sub;
  const rows = await db.select({
    didId: agentDids.didId,
    number: dids.number,
    country: dids.country,
  }).from(agentDids)
    .innerJoin(dids, eq(agentDids.didId, dids.id))
    .where(eq(agentDids.agentId, userId));
  return c.json({ data: rows });
});

export default router;
