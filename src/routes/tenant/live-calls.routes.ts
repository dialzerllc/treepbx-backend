import { Hono } from 'hono';
import { z } from 'zod';
import { inArray, and, eq, desc, count, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, users, campaigns } from '../../db/schema';
import { paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

// Live monitoring needs a wider window than the standard 50-row paginator.
// 2000 matches FS max-sessions ceiling, so the UI never silently truncates.
const liveListSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(2000).default(2000),
});

// List active calls scoped to this tenant
router.get('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = liveListSchema.parse(c.req.query());
  const offset = (raw.page - 1) * raw.limit;
  const limit = raw.limit;

  const where = and(
    eq(calls.tenantId, tenantId),
    inArray(calls.status, ['ringing', 'answered']),
    isNull(calls.endedAt),
  );

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: calls.id,
      freeswitchUuid: calls.freeswitchUuid,
      direction: calls.direction,
      callerId: calls.callerId,
      callerName: calls.callerName,
      calleeNumber: calls.calleeNumber,
      status: calls.status,
      agentId: calls.agentId,
      agentFirstName: users.firstName,
      agentLastName: users.lastName,
      campaignId: calls.campaignId,
      campaignName: campaigns.name,
      startedAt: calls.startedAt,
      answeredAt: calls.answeredAt,
      carrier: calls.carrier,
      mos: calls.mos,
    })
      .from(calls)
      .leftJoin(users, eq(calls.agentId, users.id))
      .leftJoin(campaigns, eq(calls.campaignId, campaigns.id))
      .where(where)
      .orderBy(desc(calls.startedAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(calls).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), { ...raw, order: 'desc' }));
});

// Listen/Whisper/Barge require ESL eavesdrop wiring not yet built.
// Return 501 so the UI doesn't pretend it worked.
const NOT_IMPLEMENTED = { error: 'Live monitoring not yet available', code: 'NOT_IMPLEMENTED' };
router.post('/:id/listen',  requireRole('tenant_admin', 'supervisor'), (c) => c.json(NOT_IMPLEMENTED, 501));
router.post('/:id/whisper', requireRole('tenant_admin', 'supervisor'), (c) => c.json(NOT_IMPLEMENTED, 501));

// Hangup an active call belonging to this tenant
router.post('/:id/hangup', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [call] = await db.select({ id: calls.id, freeswitchUuid: calls.freeswitchUuid })
    .from(calls)
    .where(and(eq(calls.id, c.req.param('id')), eq(calls.tenantId, tenantId)));
  if (!call) throw new NotFound('Call not found');
  const { eslClient } = await import('../../esl/client');
  if (call.freeswitchUuid && eslClient.isConnected()) {
    eslClient.api(`uuid_kill ${call.freeswitchUuid}`);
  }
  return c.json({ ok: true, action: 'hangup', callId: call.id, uuid: call.freeswitchUuid });
});

export default router;
