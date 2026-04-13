import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client';
import { fraudKeywords, fraudAlerts } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';

const router = new Hono();

const keywordSchema = z.object({
  tenantId: z.string().uuid().nullable().optional(),
  keyword: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  isPhrase: z.boolean().default(false),
  isRegex: z.boolean().default(false),
  notifyEmail: z.boolean().default(true),
  notifySms: z.boolean().default(false),
  notifyWebhook: z.boolean().default(false),
  notifyInApp: z.boolean().default(true),
  escalateToSupervisor: z.boolean().default(false),
  autoRecordCall: z.boolean().default(false),
  active: z.boolean().default(true),
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
    tenantId: z.string().uuid().optional(),
    status: z.string().optional(),
    severity: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }).parse(c.req.query());
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

router.put('/alerts/:id/status', async (c) => {
  const body = z.object({
    status: z.enum(['new', 'reviewed', 'dismissed', 'escalated']),
    reviewedBy: z.string().uuid().optional(),
  }).parse(await c.req.json());

  const [row] = await db.update(fraudAlerts).set({
    status: body.status,
    reviewedBy: body.reviewedBy,
    reviewedAt: new Date(),
  }).where(eq(fraudAlerts.id, c.req.param('id'))).returning();
  if (!row) throw new NotFound('Fraud alert not found');
  return c.json(row);
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
