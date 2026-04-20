import { Hono } from 'hono';
import { z } from 'zod';
import { optionalUuid } from '../../lib/zod-helpers';
import { eq, and, like, desc, count, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client';
import { fraudKeywords, fraudAlerts } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const keywordSchema = z.object({
  tenantId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  keyword: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  isPhrase: z.boolean().nullable().default(false),
  isRegex: z.boolean().nullable().default(false),
  notifyEmail: z.boolean().nullable().default(true),
  notifySms: z.boolean().nullable().default(false),
  notifyWebhook: z.boolean().nullable().default(false),
  notifyInApp: z.boolean().nullable().default(true),
  escalateToSupervisor: z.boolean().nullable().default(false),
  autoRecordCall: z.boolean().nullable().default(false),
  active: z.boolean().nullable().default(true),
});

// Fraud Keywords CRUD
router.get('/', async (c) => {
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const where = raw.search ? like(fraudKeywords.keyword, `%${raw.search}%`) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(fraudKeywords).where(where).orderBy(desc(fraudKeywords.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(fraudKeywords).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Fraud Alerts — must be before /:id to avoid route shadowing
router.get('/alerts', async (c) => {
  const raw = paginationSchema.extend({
    tenantId: optionalUuid(),
    status: z.string().nullable().optional(),
    severity: z.string().nullable().optional(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [];
  if (raw.tenantId) conditions.push(eq(fraudAlerts.tenantId, raw.tenantId));
  if (raw.status) conditions.push(eq(fraudAlerts.status, raw.status));
  if (raw.severity) conditions.push(eq(fraudAlerts.severity, raw.severity));
  if (raw.from) conditions.push(gte(fraudAlerts.createdAt, new Date(raw.from)));
  if (raw.to) conditions.push(lte(fraudAlerts.createdAt, new Date(raw.to)));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(fraudAlerts).where(where).orderBy(desc(fraudAlerts.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(fraudAlerts).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Update fraud alert (frontend sends PUT /fraud/alerts/:id with {status})
router.put('/alerts/:id', async (c) => {
  const body = z.object({
    status: z.enum(['new', 'reviewed', 'dismissed', 'escalated']),
    reviewedBy: optionalUuid(),
  }).passthrough().parse(await c.req.json());

  const userId = c.get('user')?.sub;
  const [row] = await db.update(fraudAlerts).set({
    status: body.status,
    reviewedBy: body.reviewedBy || userId,
    reviewedAt: new Date(),
  }).where(eq(fraudAlerts.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Fraud alert not found');
  return c.json(row);
});

// GET /scans — live scan data (active calls being monitored)
router.get('/scans', async (c) => {
  const { calls } = await import('../../db/schema');
  const { inArray } = await import('drizzle-orm');

  // Return active calls flagged for fraud monitoring
  const rows = await db.select({
    id: calls.id,
    tenantId: calls.tenantId,
    callerId: calls.callerId,
    calleeNumber: calls.calleeNumber,
    direction: calls.direction,
    status: calls.status,
    startedAt: calls.startedAt,
    fraudFlagged: calls.fraudFlagged,
  }).from(calls)
    .where(inArray(calls.status, ['ringing', 'answered']))
    .orderBy(desc(calls.startedAt))
    .limit(100);

  return c.json({ data: rows });
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(fraudKeywords).where(eq(fraudKeywords.id, c.req.param('id')));
  if (!row) throw new NotFound('Fraud keyword not found');
  return c.json(row);
});

router.post('/', async (c) => {
  const body = keywordSchema.parse(await c.req.json());
  const [row] = await db.insert(fraudKeywords).values(body).returning();
  return c.json(row, 201);
});

router.put('/:id', async (c) => {
  const body = keywordSchema.partial().parse(await c.req.json());
  const [row] = await db.update(fraudKeywords).set(body).where(eq(fraudKeywords.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Fraud keyword not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.delete(fraudKeywords).where(eq(fraudKeywords.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Fraud keyword not found');
  return c.json({ ok: true });
});

export default router;
