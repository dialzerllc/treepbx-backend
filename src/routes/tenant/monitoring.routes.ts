import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, isNull, inArray, desc } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, agentSessions, calls } from '../../db/schema';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

// List agents with live status
router.get('/agents', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;

  const agents = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    email: users.email,
    role: users.role,
    status: users.status,
    statusChangedAt: users.statusChangedAt,
    teamId: users.teamId,
    sipUsername: users.sipUsername,
  }).from(users)
    .where(and(
      eq(users.tenantId, tenantId),
      inArray(users.role, ['agent', 'supervisor', 'tenant_admin']),
      isNull(users.deletedAt),
    ))
    .orderBy(users.firstName);

  // Enrich with active session and current call
  const agentIds = agents.map((a) => a.id);

  const [sessions, activeCalls] = agentIds.length
    ? await Promise.all([
        db.select().from(agentSessions)
          .where(and(inArray(agentSessions.agentId, agentIds), isNull(agentSessions.logoutAt))),
        db.select().from(calls)
          .where(and(
            inArray(calls.agentId, agentIds),
            inArray(calls.status, ['ringing', 'answered']),
          )),
      ])
    : [[], []];

  const sessionMap = Object.fromEntries(sessions.map((s) => [s.agentId, s]));
  const callMap = Object.fromEntries(activeCalls.map((c) => [c.agentId, c]));

  const enriched = agents.map((a) => ({
    ...a,
    session: sessionMap[a.id] ?? null,
    activeCall: callMap[a.id] ?? null,
  }));

  return c.json({ data: enriched });
});

// Listen / Whisper / Barge — require live FreeSWITCH ESL bridging that is not
// wired yet. Return 501 instead of a misleading {ok:true} so the UI surfaces an
// honest error. Frontend should hide these buttons until the ESL path is built.
const NOT_IMPLEMENTED = { error: 'Live monitoring not yet available', code: 'NOT_IMPLEMENTED' };
router.post('/listen/:agentId',  requireRole('tenant_admin', 'supervisor'), (c) => c.json(NOT_IMPLEMENTED, 501));
router.post('/whisper/:agentId', requireRole('tenant_admin', 'supervisor'), (c) => c.json(NOT_IMPLEMENTED, 501));
router.post('/barge/:agentId',   requireRole('tenant_admin', 'supervisor'), (c) => c.json(NOT_IMPLEMENTED, 501));

export default router;
