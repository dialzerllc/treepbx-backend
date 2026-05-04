import { Hono } from 'hono';
import { z } from 'zod';
import { optionalUuid } from '../../lib/zod-helpers';
import { inArray, and, eq, desc, count, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    tenantId: optionalUuid(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const activeStatuses = ['ringing', 'answered'];
  const conditions: ReturnType<typeof eq>[] = [
    inArray(calls.status, activeStatuses) as any,
    isNull(calls.endedAt) as any,
  ];
  if (raw.tenantId) conditions.push(eq(calls.tenantId, raw.tenantId) as any);
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
      status: calls.status,
      agentId: calls.agentId,
      campaignId: calls.campaignId,
      startedAt: calls.startedAt,
      answeredAt: calls.answeredAt,
      carrier: calls.carrier,
      mos: calls.mos,
    }).from(calls).where(where).orderBy(desc(calls.startedAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(calls).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.post('/:id/listen', async (c) => {
  const [call] = await db.select({ id: calls.id, freeswitchUuid: calls.freeswitchUuid })
    .from(calls).where(eq(calls.id, c.req.param('id')));
  if (!call) throw new NotFound('Call not found');
  // ESL integration placeholder
  return c.json({ ok: true, action: 'listen', callId: call.id, uuid: call.freeswitchUuid });
});

router.post('/:id/whisper', async (c) => {
  const [call] = await db.select({ id: calls.id, freeswitchUuid: calls.freeswitchUuid })
    .from(calls).where(eq(calls.id, c.req.param('id')));
  if (!call) throw new NotFound('Call not found');
  // ESL integration placeholder
  return c.json({ ok: true, action: 'whisper', callId: call.id, uuid: call.freeswitchUuid });
});

router.post('/:id/hangup', async (c) => {
  const [call] = await db.select({ id: calls.id, freeswitchUuid: calls.freeswitchUuid })
    .from(calls).where(eq(calls.id, c.req.param('id')));
  if (!call) throw new NotFound('Call not found');
  // ESL integration placeholder
  return c.json({ ok: true, action: 'hangup', callId: call.id, uuid: call.freeswitchUuid });
});

export default router;
