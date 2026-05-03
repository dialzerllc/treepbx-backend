import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { audioFiles, businessHours } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';
import { uploadFile, getFileUrl, getFileBuffer } from '../../integrations/minio';

const router = new Hono();

const audioSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  minioKey: z.string().optional(),
  durationSeconds: z.union([z.number(), z.string()]).optional().transform((v) => v !== undefined && v !== '' ? String(v) : undefined),
  format: z.enum(['wav', 'mp3', 'ogg']).default('wav'),
  sizeBytes: z.preprocess((v) => (v === '' || v === undefined ? undefined : v), z.coerce.number().int().optional()),
  source: z.enum(['upload', 'tts', 'recording']).default('upload'),
  ttsText: z.string().nullable().optional(),
  ttsVoice: z.string().nullable().optional(),
  category: z.string().default('general'),
  fileData: z.string().nullable().optional(),
});

const businessHoursSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().nullable().default(true),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  days: z.array(z.string()).nullable().default([]),
  timezone: z.string().default('America/New_York'),
  routeType: z.string().nullable().optional(),
  routeTargetId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
});

// === Named routes MUST come before /:id ===

// Upload file to MinIO and return the key + presigned URL
router.post('/upload', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Missing "file" field in multipart form data' }, 400);
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = file.name.split('.').pop() ?? 'wav';
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `audio/${tenantId}/${Date.now()}-${safeName}`;

  await uploadFile(key, buffer, file.type || `audio/${ext}`);
  const url = await getFileUrl(key);

  return c.json({ key, url, name: file.name, size: buffer.length, contentType: file.type }, 201);
});

// TTS placeholder
router.post('/tts', requireRole('tenant_admin', 'supervisor'), async (c) => {
  return c.json({ ok: true, message: 'TTS generation queued' }, 202);
});

// Business hours (after-hours) sub-routes
router.get('/after-hours', async (c) => {
  const tenantId = c.get('tenantId')!;
  const rows = await db.select().from(businessHours)
    .where(eq(businessHours.tenantId, tenantId)).orderBy(desc(businessHours.createdAt));
  return c.json({ data: rows });
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
    category: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
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

// Play audio — streams the file. Inline fileData (legacy/TTS) wins; otherwise
// fall back to fetching the bytes from MinIO using minioKey.
router.get('/:id/play', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select({
    fileData: audioFiles.fileData,
    minioKey: audioFiles.minioKey,
    format: audioFiles.format,
  }).from(audioFiles)
    .where(and(eq(audioFiles.id, c.req.param('id')), eq(audioFiles.tenantId, tenantId)));
  if (!row) throw new NotFound('Audio file not found');

  const mimeMap: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg' };
  const mime = mimeMap[row.format ?? 'wav'] ?? 'audio/wav';

  let buffer: Buffer;
  if (row.fileData) {
    buffer = Buffer.from(row.fileData, 'base64');
  } else if (row.minioKey) {
    try {
      buffer = await getFileBuffer(row.minioKey);
    } catch (err: any) {
      return c.json({ error: 'Audio bytes not found in object store', minioKey: row.minioKey }, 404);
    }
  } else {
    return c.json({ error: 'No audio data available' }, 404);
  }

  c.header('Content-Type', mime);
  c.header('Content-Length', String(buffer.length));
  return c.body(buffer);
});

router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = audioSchema.parse(await c.req.json());
  const [dup] = await db.select({ id: audioFiles.id }).from(audioFiles)
    .where(and(eq(audioFiles.name, body.name), eq(audioFiles.tenantId, tenantId)));
  if (dup) throw new BadRequest('Audio file name already exists');
  if (!body.minioKey) {
    body.minioKey = `audio/${tenantId}/${Date.now()}-${body.name.replace(/[^a-zA-Z0-9]/g, '_')}.${body.format ?? 'wav'}`;
  }
  const [row] = await db.insert(audioFiles).values({ ...body as any, tenantId }).returning();
  return c.json(row, 201);
});

router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = audioSchema.partial().omit({ minioKey: true }).passthrough().parse(await c.req.json());
  if (body.name) {
    const [dup] = await db.select({ id: audioFiles.id }).from(audioFiles)
      .where(and(eq(audioFiles.name, body.name), eq(audioFiles.tenantId, tenantId), sql`${audioFiles.id} != ${c.req.param('id')}`));
    if (dup) throw new BadRequest('Audio file name already exists');
  }
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
