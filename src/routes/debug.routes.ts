import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { errorLog, users } from '../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../lib/pagination';
import { requireRole } from '../middleware/roles';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../lib/logger';

const router = new Hono();
router.use('*', authMiddleware);

// /errors* are super_admin / platform_supervisor only;
// /client-error is open to any authenticated user (browser-error reporter).
router.get('/errors', requireRole('super_admin', 'platform_supervisor'), async (c) => {
  const raw = paginationSchema.extend({
    level: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [];
  if (raw.level) conditions.push(eq(errorLog.level, raw.level));
  if (raw.source) conditions.push(eq(errorLog.source, raw.source));
  if (raw.path) conditions.push(sql`${errorLog.path} ILIKE ${'%' + raw.path + '%'}`);
  if (raw.search) conditions.push(sql`${errorLog.errMessage} ILIKE ${'%' + raw.search + '%'}`);
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: errorLog.id,
      level: errorLog.level,
      source: errorLog.source,
      method: errorLog.method,
      path: errorLog.path,
      statusCode: errorLog.statusCode,
      errType: errorLog.errType,
      errMessage: errorLog.errMessage,
      stack: errorLog.stack,
      context: errorLog.context,
      userId: errorLog.userId,
      userEmail: users.email,
      tenantId: errorLog.tenantId,
      createdAt: errorLog.createdAt,
    }).from(errorLog)
      .leftJoin(users, eq(errorLog.userId, users.id))
      .where(where)
      .orderBy(desc(errorLog.createdAt))
      .limit(limit).offset(offset),
    db.select({ total: count() }).from(errorLog).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Stats: counts grouped by source/level + last 24h.
router.get('/errors/stats', requireRole('super_admin', 'platform_supervisor'), async (c) => {
  const [{ total }] = await db.select({ total: count() }).from(errorLog);
  const last24h = await db.select({ total: count() })
    .from(errorLog)
    .where(sql`${errorLog.createdAt} > now() - interval '24 hours'`);
  const bySource = await db.select({
    source: errorLog.source,
    level: errorLog.level,
    n: count(),
  }).from(errorLog).groupBy(errorLog.source, errorLog.level);
  return c.json({
    total: Number(total),
    last24h: Number(last24h[0]?.total ?? 0),
    breakdown: bySource.map((r) => ({ source: r.source, level: r.level, count: Number(r.n) })),
  });
});

// Clear all (super_admin only).
router.delete('/errors', requireRole('super_admin'), async (c) => {
  const deleted = await db.delete(errorLog).returning({ id: errorLog.id });
  logger.info({ count: deleted.length }, '[debug] cleared error log');
  return c.json({ ok: true, deleted: deleted.length });
});

// Single delete.
router.delete('/errors/:id', requireRole('super_admin'), async (c) => {
  await db.delete(errorLog).where(eq(errorLog.id, c.req.param('id')));
  return c.json({ ok: true });
});

// Frontend error reporter — open to any authenticated user. Captures
// window.onerror / unhandledrejection from the SPA. Untrusted input, so we
// truncate generously to avoid storing megabyte stacks.
const trunc = (s: unknown, n: number) => typeof s === 'string' ? s.slice(0, n) : null;
router.post('/client-error', async (c) => {
  const body = z.object({
    message: z.string().min(1),
    stack: z.string().optional(),
    path: z.string().optional(),
    userAgent: z.string().optional(),
    url: z.string().optional(),
    extra: z.record(z.unknown()).optional(),
  }).parse(await c.req.json());
  const userId = c.get('userId') ?? null;
  const tenantId = c.get('tenantId') ?? null;
  await db.insert(errorLog).values({
    level: 'error',
    source: 'client',
    path: trunc(body.path ?? body.url, 500),
    userId,
    tenantId,
    errMessage: trunc(body.message, 2000) ?? '',
    stack: trunc(body.stack, 8000),
    context: {
      userAgent: trunc(body.userAgent, 500),
      url: trunc(body.url, 500),
      ...(body.extra ?? {}),
    },
  });
  return c.json({ ok: true });
});

export default router;
