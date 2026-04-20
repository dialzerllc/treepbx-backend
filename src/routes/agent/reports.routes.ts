import { Hono } from 'hono';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, callRecordings } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';

const router = new Hono();

// GET /cdr — own call detail records
router.get('/cdr', async (c) => {
  const userId = c.get('user').sub;
  const query = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(query);
  const from = c.req.query('from');
  const to = c.req.query('to');

  const conditions = [eq(calls.agentId, userId)];
  if (from) conditions.push(gte(calls.startedAt, new Date(from)));
  if (to) conditions.push(lte(calls.startedAt, new Date(to)));

  const rows = await db.select().from(calls)
    .where(and(...conditions))
    .orderBy(desc(calls.startedAt))
    .offset(offset).limit(limit);

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
    .from(calls).where(and(...conditions));

  return c.json(paginatedResponse(rows, total, query));
});

// GET /stats — own performance stats
router.get('/stats', async (c) => {
  const userId = c.get('user').sub;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [stats] = await db.select({
    callsToday: sql<number>`count(*)::int`,
    answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
    avgDuration: sql<number>`coalesce(avg(${calls.durationSeconds}), 0)::int`,
    talkTime: sql<number>`coalesce(sum(${calls.talkTimeSeconds}), 0)::int`,
    holdTime: sql<number>`coalesce(sum(${calls.holdTimeSeconds}), 0)::int`,
    wrapTime: sql<number>`coalesce(sum(${calls.wrapTimeSeconds}), 0)::int`,
  }).from(calls).where(and(eq(calls.agentId, userId), gte(calls.startedAt, today)));

  return c.json(stats);
});

// GET /recordings — own recordings
router.get('/recordings', async (c) => {
  const userId = c.get('user').sub;

  const rows = await db.select({
    id: callRecordings.id,
    callId: callRecordings.callId,
    format: callRecordings.format,
    durationSeconds: callRecordings.durationSeconds,
    sizeBytes: callRecordings.sizeBytes,
    transcriptStatus: callRecordings.transcriptStatus,
    createdAt: callRecordings.createdAt,
  })
    .from(callRecordings)
    .innerJoin(calls, eq(calls.id, callRecordings.callId))
    .where(eq(calls.agentId, userId))
    .orderBy(desc(callRecordings.createdAt))
    .limit(100);

  return c.json({ data: rows });
});

// GET /recordings/:id/download — download recording
router.get('/recordings/:id/download', async (c) => {
  const userId = c.get('user').sub;
  const [row] = await db.select({ id: callRecordings.id, minioKey: callRecordings.minioKey })
    .from(callRecordings)
    .innerJoin(calls, eq(calls.id, callRecordings.callId))
    .where(and(eq(callRecordings.id, c.req.param('id')), eq(calls.agentId, userId)));
  if (!row) return c.json({ error: 'Recording not found' }, 404);
  return c.json({ url: `/stream/${row.minioKey}?download=1` });
});

// GET /dispositions — own disposition breakdown
router.get('/dispositions', async (c) => {
  const userId = c.get('user').sub;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows = await db.select({
    disposition: calls.disposition,
    count: sql<number>`count(*)::int`,
  })
    .from(calls)
    .where(and(eq(calls.agentId, userId), gte(calls.startedAt, today)))
    .groupBy(calls.disposition);

  return c.json({ data: rows });
});

export default router;
