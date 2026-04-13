import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { audioFiles, businessHours } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const audioSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  minioKey: z.string().min(1),
  durationSeconds: z.union([z.number(), z.string()]).transform(String).optional(),
  format: z.enum(['wav', 'mp3', 'ogg']).default('wav'),
  sizeBytes: z.number().int().positive().optional(),
  source: z.enum(['upload', 'tts', 'recording']).default('upload'),
  ttsText: z.string().optional(),
  ttsVoice: z.string().optional(),
  category: z.string().default('general'),
});

const businessHoursSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  days: z.array(z.string()).default([]),
  timezone: z.string().default('America/New_York'),
  routeType: z.string().optional(),
  routeTargetId: z.string().uuid().nullable().optional(),
});

// === Named routes MUST come before /:id ===

// TTS placeholder
router.post('/tts', requireRole('tenant_admin', 'supervisor'), async (c) => {
  return c.json({ ok: true, message: 'TTS generation queued' }, 202);
});

// Business hours (after-hours) sub-routes
router.get('/after-hours', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select().from(businessHours)
    .where(eq(businessHours.tenantId, tenantId)).orderBy(desc(businessHours.createdAt));
  return c.json(rows);
});

router.post('/after-hours', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = businessHoursSchema.parse(await c.req.json());
  const [row] = await db.insert(businessHours).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/after-hours/:hid', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = businessHoursSchema.partial().parse(await c.req.json());
  const [row] = await db.update(businessHours).set(body)
    .where(and(eq(businessHours.id, c.req.param('hid')), eq(businessHours.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Business hours profile not found');
  return c.json(row);
});

router.delete('/after-hours/:hid', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(businessHours)
    .where(and(eq(businessHours.id, c.req.param('hid')), eq(businessHours.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Business hours profile not found');
  return c.json({ ok: true });
});

// === Standard CRUD (/:id routes) ===

// List audio files
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    category: z.string().optional(),
    source: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(audioFiles.tenantId, tenantId)];
  if (raw.search) conditions.push(like(audioFiles.name, `%${raw.search}%`));
  if (raw.category) conditions.push(eq(audioFiles.category, raw.category));
  if (raw.source) conditions.push(eq(audioFiles.source, raw.source));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(audioFiles).where(where).orderBy(desc(audioFiles.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(audioFiles).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(audioFiles)
    .where(and(eq(audioFiles.id, c.req.param('id')), eq(audioFiles.tenantId, tenantId)));
  if (!row) throw new NotFound('Audio file not found');
  return c.json(row);
});

router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = audioSchema.parse(await c.req.json());
  const [row] = await db.insert(audioFiles).values({ ...body, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = audioSchema.partial().omit({ minioKey: true }).parse(await c.req.json());
  const [row] = await db.update(audioFiles).set(body)
    .where(and(eq(audioFiles.id, c.req.param('id')), eq(audioFiles.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Audio file not found');
  return c.json(row);
});

router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(audioFiles)
    .where(and(eq(audioFiles.id, c.req.param('id')), eq(audioFiles.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Audio file not found');
  return c.json({ ok: true });
});

export default router;
