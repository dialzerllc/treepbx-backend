import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, gte, lte, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    tenantId: z.string().uuid().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    callerId: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [isNotNull(calls.freeswitchUuid)];
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
      calleeNumber: calls.calleeNumber,
      status: calls.status,
      disposition: calls.disposition,
      hangupCause: calls.hangupCause,
      startedAt: calls.startedAt,
      answeredAt: calls.answeredAt,
      endedAt: calls.endedAt,
      durationSeconds: calls.durationSeconds,
      carrier: calls.carrier,
      carrierIp: calls.carrierIp,
      mos: calls.mos,
      jitterMs: calls.jitterMs,
      packetLossPct: calls.packetLossPct,
    }).from(calls).where(where).orderBy(desc(calls.startedAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(calls).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:uuid', async (c) => {
  const [row] = await db.select().from(calls).where(eq(calls.freeswitchUuid, c.req.param('uuid')));
  if (!row) throw new NotFound('Call not found');
  return c.json(row);
});

export default router;
