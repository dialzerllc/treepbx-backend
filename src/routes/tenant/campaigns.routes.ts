import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { campaigns } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const campaignSchema = z.object({
  name: z.string().min(1),
  dialMode: z.enum(['preview', 'progressive', 'predictive', 'power', 'voicebot']).default('progressive'),
  leadListId: z.string().uuid().nullable().optional(),
  didGroupId: z.string().uuid().nullable().optional(),
  voicebotConfigId: z.string().uuid().nullable().optional(),
  rateCardId: z.string().uuid().nullable().optional(),
  scriptId: z.string().uuid().nullable().optional(),
  dialRatio: z.union([z.number(), z.string()]).transform(String).default('1.0'),
  maxAbandonRate: z.union([z.number(), z.string()]).transform(String).default('3.0'),
  wrapUpSeconds: z.number().int().min(0).default(30),
  ringTimeoutSeconds: z.number().int().positive().default(25),
  amdEnabled: z.boolean().default(false),
  amdTimeoutMs: z.number().int().positive().default(3500),
  amdAction: z.string().default('hangup'),
  amdTransferTarget: z.string().optional(),
  recordingMode: z.enum(['all', 'none', 'on_demand']).default('all'),
  recordingFormat: z.enum(['wav', 'mp3', 'ogg']).default('wav'),
  byocRouting: z.enum(['platform', 'byoc']).default('platform'),
  byocCarrierId: z.string().uuid().nullable().optional(),
  scheduledStart: z.coerce.date().nullable().optional(),
  scheduledEnd: z.coerce.date().nullable().optional(),
  dialingDays: z.array(z.string()).default(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
  dialingStartTime: z.string().default('09:00'),
  dialingEndTime: z.string().default('17:00'),
  scheduleTimezone: z.string().default('America/New_York'),
  maxCallsPerDay: z.number().int().min(0).default(0),
  maxAttemptsPerLead: z.number().int().positive().default(3),
  retryDelayMinutes: z.number().int().positive().default(60),
  respectLeadTimezone: z.boolean().default(true),
  pauseOnHolidays: z.boolean().default(true),
  dispositionRequired: z.boolean().default(true),
  enabledDispositions: z.array(z.string()).default([]),
  transferEnabled: z.boolean().default(false),
  transferType: z.string().default('blind'),
  transferDestType: z.string().default('external'),
  transferTarget: z.string().optional(),
  botQualifiedAction: z.string().optional(),
  botQualifiedTarget: z.string().optional(),
});

// List campaigns
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    status: z.string().optional(),
    dialMode: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(campaigns.tenantId, tenantId)];
  if (raw.search) conditions.push(like(campaigns.name, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(campaigns.status, raw.status));
  if (raw.dialMode) conditions.push(eq(campaigns.dialMode, raw.dialMode));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(campaigns).where(where).orderBy(desc(campaigns.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(campaigns).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Get single campaign
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.select().from(campaigns)
    .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)));
  if (!row) throw new NotFound('Campaign not found');
  return c.json(row);
});

// Create campaign
router.post('/', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const body = campaignSchema.parse(await c.req.json());
  const [row] = await db.insert(campaigns).values({
    ...body,
    tenantId,
    createdBy: userId,
    status: 'draft',
  }).returning();
  return c.json(row, 201);
});

// Update campaign
router.put('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = campaignSchema.partial().parse(await c.req.json());
  const [row] = await db.update(campaigns)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Campaign not found');
  return c.json(row);
});

// Delete campaign
router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(campaigns)
    .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('Campaign not found');
  return c.json({ ok: true });
});

// Clone campaign
router.post('/:id/clone', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const userId = c.get('user').sub;
  const [original] = await db.select().from(campaigns)
    .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)));
  if (!original) throw new NotFound('Campaign not found');

  const { id, createdAt, updatedAt, ...rest } = original;
  const [cloned] = await db.insert(campaigns).values({
    ...rest,
    name: `${original.name} (Copy)`,
    status: 'draft',
    createdBy: userId,
  }).returning();

  return c.json(cloned, 201);
});

// Update campaign status
router.put('/:id/status', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({ status: z.enum(['active', 'paused', 'draft', 'completed']) }).parse(await c.req.json());

  const [existing] = await db.select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns).where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.tenantId, tenantId)));
  if (!existing) throw new NotFound('Campaign not found');

  const [row] = await db.update(campaigns)
    .set({ status: body.status, updatedAt: new Date() })
    .where(eq(campaigns.id, existing.id))
    .returning();

  return c.json(row);
});

export default router;
