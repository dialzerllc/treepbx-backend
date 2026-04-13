import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, gte, lte, desc, count, sum, avg, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { calls, callRecordings, users, campaigns, agentSessions } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const dateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// CDR - Call Detail Records
router.get('/cdr', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    from: z.string().optional(),
    to: z.string().optional(),
    agentId: z.string().uuid().optional(),
    campaignId: z.string().uuid().optional(),
    direction: z.string().optional(),
    status: z.string().optional(),
    disposition: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(calls.tenantId, tenantId)];
  if (raw.from) conditions.push(gte(calls.startedAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(calls.startedAt, new Date(raw.to)));
  if (raw.agentId) conditions.push(eq(calls.agentId, raw.agentId));
  if (raw.campaignId) conditions.push(eq(calls.campaignId, raw.campaignId));
  if (raw.direction) conditions.push(eq(calls.direction, raw.direction));
  if (raw.status) conditions.push(eq(calls.status, raw.status));
  if (raw.disposition) conditions.push(eq(calls.disposition, raw.disposition));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(calls).where(where).orderBy(desc(calls.startedAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(calls).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Recordings
router.get('/recordings', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    from: z.string().optional(),
    to: z.string().optional(),
    transcriptStatus: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(callRecordings.tenantId, tenantId)];
  if (raw.from) conditions.push(gte(callRecordings.createdAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(callRecordings.createdAt, new Date(raw.to)));
  if (raw.transcriptStatus) conditions.push(eq(callRecordings.transcriptStatus, raw.transcriptStatus));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(callRecordings).where(where).orderBy(desc(callRecordings.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(callRecordings).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Play recording - placeholder
router.get('/recordings/:id/play', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({ id: callRecordings.id, minioKey: callRecordings.minioKey })
    .from(callRecordings).where(and(eq(callRecordings.id, c.req.param('id')), eq(callRecordings.tenantId, tenantId)));
  if (!row) throw new NotFound('Recording not found');
  return c.json({ ok: true, streamUrl: `/stream/${row.minioKey}` });
});

// Agent performance
router.get('/agents', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }).parse(c.req.query());

  const conditions: any[] = [eq(calls.tenantId, tenantId)];
  if (raw.from) conditions.push(gte(calls.startedAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(calls.startedAt, new Date(raw.to)));
  const where = and(...conditions);

  const rows = await db.select({
    agentId: calls.agentId,
    totalCalls: count(),
    avgDuration: avg(calls.durationSeconds),
    totalTalkSeconds: sum(calls.talkTimeSeconds),
  }).from(calls).where(where).groupBy(calls.agentId);

  return c.json(rows);
});

// Campaign summary
router.get('/campaigns', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }).parse(c.req.query());

  const conditions: any[] = [eq(calls.tenantId, tenantId)];
  if (raw.from) conditions.push(gte(calls.startedAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(calls.startedAt, new Date(raw.to)));
  const where = and(...conditions);

  const rows = await db.select({
    campaignId: calls.campaignId,
    totalCalls: count(),
    avgDuration: avg(calls.durationSeconds),
    totalCost: sum(calls.cost),
  }).from(calls).where(where).groupBy(calls.campaignId);

  return c.json(rows);
});

// Export - placeholder
router.post('/export', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const body = z.object({
    type: z.enum(['cdr', 'recordings', 'agents', 'campaigns']),
    from: z.string().optional(),
    to: z.string().optional(),
    format: z.enum(['csv', 'xlsx']).default('csv'),
  }).parse(await c.req.json());

  return c.json({ ok: true, message: 'Export queued', downloadUrl: null }, 202);
});

export default router;
