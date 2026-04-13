import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count } from 'drizzle-orm';
import { db } from '../../db/client';
import { ivrMenus, ivrMenuActions } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

const menuSchema = z.object({
  name: z.string().min(1),
  welcomeAudioId: z.string().uuid().nullable().optional(),
  timeoutSeconds: z.number().int().positive().default(5),
  maxRetries: z.number().int().positive().default(3),
  invalidAudioId: z.string().uuid().nullable().optional(),
  timeoutAudioId: z.string().uuid().nullable().optional(),
  timeoutAction: z.string().default('hangup'),
  timeoutTargetId: z.string().uuid().nullable().optional(),
  afterHoursEnabled: z.boolean().default(false),
  afterHoursProfileId: z.string().uuid().nullable().optional(),
});

const actionSchema = z.object({
  dtmfKey: z.string().min(1).max(1),
  actionType: z.string().min(1),
  targetId: z.string().uuid().nullable().optional(),
  targetNumber: z.string().optional(),
  audioId: z.string().uuid().nullable().optional(),
  label: z.string().optional(),
});

// List IVR menus
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.parse(c.req.query());
  const { offset, limit } = paginate(raw);
  const where = eq(ivrMenus.tenantId, tenantId);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(ivrMenus).where(where).orderBy(desc(ivrMenus.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(ivrMenus).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Get IVR menu with actions
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [menu] = await db.select().from(ivrMenus)
    .where(and(eq(ivrMenus.id, c.req.param('id')), eq(ivrMenus.tenantId, tenantId)));
  if (!menu) throw new NotFound('IVR menu not found');

  const actions = await db.select().from(ivrMenuActions)
    .where(eq(ivrMenuActions.ivrMenuId, menu.id));

  return c.json({ ...menu, actions });
});

// Create IVR menu
router.post('/', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    menu: menuSchema,
    actions: z.array(actionSchema).optional(),
  }).parse(await c.req.json());

  const [menu] = await db.insert(ivrMenus).values({ ...body.menu, tenantId }).returning();

  let actions: typeof ivrMenuActions.$inferSelect[] = [];
  if (body.actions?.length) {
    actions = await db.insert(ivrMenuActions)
      .values(body.actions.map((a) => ({ ...a, ivrMenuId: menu.id })))
      .returning();
  }

  return c.json({ ...menu, actions }, 201);
});

// Update IVR menu
router.put('/:id', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    menu: menuSchema.partial().optional(),
    actions: z.array(actionSchema).optional(),
  }).parse(await c.req.json());

  const [existing] = await db.select({ id: ivrMenus.id }).from(ivrMenus)
    .where(and(eq(ivrMenus.id, c.req.param('id')), eq(ivrMenus.tenantId, tenantId)));
  if (!existing) throw new NotFound('IVR menu not found');

  let menu = existing;
  if (body.menu) {
    [menu] = await db.update(ivrMenus).set(body.menu)
      .where(eq(ivrMenus.id, existing.id)).returning();
  }

  let actions: (typeof ivrMenuActions.$inferSelect)[];
  if (body.actions !== undefined) {
    await db.delete(ivrMenuActions).where(eq(ivrMenuActions.ivrMenuId, existing.id));
    if (body.actions.length) {
      actions = await db.insert(ivrMenuActions)
        .values(body.actions.map((a) => ({ ...a, ivrMenuId: existing.id })))
        .returning();
    } else {
      actions = [];
    }
  } else {
    actions = await db.select().from(ivrMenuActions).where(eq(ivrMenuActions.ivrMenuId, existing.id));
  }

  return c.json({ ...menu, actions });
});

// Delete IVR menu
router.delete('/:id', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [row] = await db.delete(ivrMenus)
    .where(and(eq(ivrMenus.id, c.req.param('id')), eq(ivrMenus.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFound('IVR menu not found');
  return c.json({ ok: true });
});

// Clone IVR menu
router.post('/:id/clone', requireRole('tenant_admin', 'supervisor'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const [original] = await db.select().from(ivrMenus)
    .where(and(eq(ivrMenus.id, c.req.param('id')), eq(ivrMenus.tenantId, tenantId)));
  if (!original) throw new NotFound('IVR menu not found');

  const originalActions = await db.select().from(ivrMenuActions)
    .where(eq(ivrMenuActions.ivrMenuId, original.id));

  const { id, createdAt, ...rest } = original;
  const [cloned] = await db.insert(ivrMenus).values({ ...rest, name: `${original.name} (Copy)` }).returning();

  let actions: typeof ivrMenuActions.$inferSelect[] = [];
  if (originalActions.length) {
    actions = await db.insert(ivrMenuActions)
      .values(originalActions.map(({ id: _id, ivrMenuId: _mid, ...a }) => ({ ...a, ivrMenuId: cloned.id })))
      .returning();
  }

  return c.json({ ...cloned, actions }, 201);
});

export default router;
