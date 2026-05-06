import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, gte, lte, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { amdDecisions, calls, campaigns, leads } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { getFileUrl } from '../../integrations/minio';

const router = new Hono();

/**
 * Tenant-scoped AMD audit log. One row per call where AMD ran (avmd, ai_screen,
 * or broadcast). Designed for compliance review — most useful filters are
 * campaign + date range + result. The audio sample (when audio_key is set)
 * is fetched on-demand via /:id/audio so list responses stay small.
 */

const listQuery = paginationSchema.extend({
  campaignId: z.string().uuid().nullable().optional(),
  source: z.enum(['avmd', 'ai_screen', 'broadcast']).nullable().optional(),
  amdResult: z.enum(['human', 'machine', 'unknown']).nullable().optional(),
  fromDate: z.string().nullable().optional(),
  toDate: z.string().nullable().optional(),
}).passthrough();

router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = listQuery.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(amdDecisions.tenantId, tenantId)];
  if (raw.campaignId) conditions.push(eq(amdDecisions.campaignId, raw.campaignId));
  if (raw.source) conditions.push(eq(amdDecisions.source, raw.source));
  if (raw.amdResult) conditions.push(eq(amdDecisions.amdResult, raw.amdResult));
  if (raw.fromDate) conditions.push(gte(amdDecisions.createdAt, new Date(raw.fromDate)));
  if (raw.toDate) conditions.push(lte(amdDecisions.createdAt, new Date(raw.toDate)));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: amdDecisions.id,
      callId: amdDecisions.callId,
      campaignId: amdDecisions.campaignId,
      source: amdDecisions.source,
      amdResult: amdDecisions.amdResult,
      action: amdDecisions.action,
      audioKey: amdDecisions.audioKey,
      probeText: amdDecisions.probeText,
      transcript: amdDecisions.transcript,
      reason: amdDecisions.reason,
      totalLatencyMs: amdDecisions.totalLatencyMs,
      createdAt: amdDecisions.createdAt,
      campaignName: campaigns.name,
      calleeNumber: calls.calleeNumber,
    })
      .from(amdDecisions)
      .leftJoin(campaigns, eq(campaigns.id, amdDecisions.campaignId))
      .leftJoin(calls, eq(calls.id, amdDecisions.callId))
      .where(where)
      .orderBy(desc(amdDecisions.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(amdDecisions).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

/**
 * Aggregate stats — quick top-of-page summary. Same filter shape as list.
 */
router.get('/summary', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = listQuery.parse(c.req.query());

  const conditions: any[] = [eq(amdDecisions.tenantId, tenantId)];
  if (raw.campaignId) conditions.push(eq(amdDecisions.campaignId, raw.campaignId));
  if (raw.source) conditions.push(eq(amdDecisions.source, raw.source));
  if (raw.fromDate) conditions.push(gte(amdDecisions.createdAt, new Date(raw.fromDate)));
  if (raw.toDate) conditions.push(lte(amdDecisions.createdAt, new Date(raw.toDate)));
  const where = and(...conditions);

  const [agg] = await db.select({
    total: count(),
    human: sql<number>`count(*) filter (where ${amdDecisions.amdResult} = 'human')::int`,
    machine: sql<number>`count(*) filter (where ${amdDecisions.amdResult} = 'machine')::int`,
    unknown: sql<number>`count(*) filter (where ${amdDecisions.amdResult} = 'unknown')::int`,
    withAudio: sql<number>`count(*) filter (where ${amdDecisions.audioKey} is not null)::int`,
    avgLatency: sql<number>`coalesce(avg(${amdDecisions.totalLatencyMs}), 0)::int`,
  }).from(amdDecisions).where(where);

  return c.json(agg);
});

/**
 * Returns a presigned R2 URL for the audio sample. 1-hour expiry — plenty
 * for the operator to play it in the UI; not so long that a leaked URL is
 * a privacy risk if logs get exfiltrated.
 */
router.get('/:id/audio', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({
    id: amdDecisions.id,
    audioKey: amdDecisions.audioKey,
  }).from(amdDecisions)
    .where(and(eq(amdDecisions.id, c.req.param('id')), eq(amdDecisions.tenantId, tenantId)));
  if (!row) throw new NotFound('decision not found');
  if (!row.audioKey) {
    return c.json({ url: null, reason: 'no audio captured for this decision' });
  }
  const url = await getFileUrl(row.audioKey, 3600);
  return c.json({ url });
});

/**
 * CSV export — same filter shape as list. Streams a flat CSV ready for
 * regulator review or spreadsheet import. No paging — caller is expected
 * to scope by date range. Hard cap at 50k rows to avoid runaway exports.
 */
router.get('/export.csv', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = listQuery.parse(c.req.query());

  const conditions: any[] = [eq(amdDecisions.tenantId, tenantId)];
  if (raw.campaignId) conditions.push(eq(amdDecisions.campaignId, raw.campaignId));
  if (raw.source) conditions.push(eq(amdDecisions.source, raw.source));
  if (raw.amdResult) conditions.push(eq(amdDecisions.amdResult, raw.amdResult));
  if (raw.fromDate) conditions.push(gte(amdDecisions.createdAt, new Date(raw.fromDate)));
  if (raw.toDate) conditions.push(lte(amdDecisions.createdAt, new Date(raw.toDate)));
  const where = and(...conditions);

  const rows = await db.select({
    createdAt: amdDecisions.createdAt,
    campaignName: campaigns.name,
    calleeNumber: calls.calleeNumber,
    source: amdDecisions.source,
    amdResult: amdDecisions.amdResult,
    action: amdDecisions.action,
    transcript: amdDecisions.transcript,
    reason: amdDecisions.reason,
    totalLatencyMs: amdDecisions.totalLatencyMs,
    audioKey: amdDecisions.audioKey,
  })
    .from(amdDecisions)
    .leftJoin(campaigns, eq(campaigns.id, amdDecisions.campaignId))
    .leftJoin(calls, eq(calls.id, amdDecisions.callId))
    .where(where)
    .orderBy(desc(amdDecisions.createdAt))
    .limit(50000);

  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['created_at', 'campaign', 'callee', 'source', 'result', 'action', 'transcript', 'reason', 'latency_ms', 'audio_key'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.createdAt?.toISOString() ?? '',
      r.campaignName ?? '',
      r.calleeNumber ?? '',
      r.source ?? '',
      r.amdResult ?? '',
      r.action ?? '',
      r.transcript ?? '',
      r.reason ?? '',
      r.totalLatencyMs ?? '',
      r.audioKey ?? '',
    ].map(esc).join(','));
  }
  return c.body(lines.join('\n'), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="amd-decisions-${new Date().toISOString().slice(0,10)}.csv"`,
  });
});

export default router;
