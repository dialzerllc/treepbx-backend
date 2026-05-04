import { Hono } from 'hono';
import { z } from 'zod';
import { optionalUuid, optionalEmail, email } from '../../lib/zod-helpers';
import { eq, and, like, desc, count, isNull, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { tenants, users, wallets, transactions, plans } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { hashPassword } from '../../lib/password';

const router = new Hono();

const createTenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  planId: optionalUuid(),
  status: z.enum(['trial', 'active', 'suspended', 'cancelled']).default('trial'),
  billingEmail: optionalEmail(),
  timezone: z.string().default('UTC'),
  country: z.string().default('US'),
  adminEmail: email(),
  adminFirstName: z.string().min(1),
  adminLastName: z.string().min(1),
  adminPassword: z.string().min(8),
});

const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().nullable().optional(),
  customerType: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  status: z.enum(['trial', 'active', 'suspended', 'cancelled']).optional(),
  planId: z.string().nullable().optional().transform((v) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null),
  maxAgents: z.coerce.number().int().default(1).optional(),
  maxConcurrentCalls: z.coerce.number().int().default(1).optional(),
  maxDids: z.coerce.number().int().default(1).optional(),
  billingEmail: optionalEmail(),
  timezone: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  features: z.record(z.unknown()).optional(),
});

const creditSchema = z.object({
  amount: z.number().positive(),
  description: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
}).transform((v) => ({ ...v, description: v.description || v.note || undefined }));

router.get('/', async (c) => {
  const { cacheGet, cacheSet } = await import('../../lib/redis');
  const cacheKey = `tenants:list`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const raw = paginationSchema.extend({
    status: z.string().nullable().optional(),
  }).passthrough().parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [isNull(tenants.deletedAt)];
  if (raw.search) conditions.push(like(tenants.name, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(tenants.status, raw.status));

  const where = and(...conditions);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(tenants).where(where).orderBy(desc(tenants.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(tenants).where(where),
  ]);

  // Enrich with wallet balance + plan name
  const tenantIds = rows.map((r) => r.id);
  const planIds = rows.map((r) => r.planId).filter((id): id is string => !!id);
  const [allWallets, allPlans] = await Promise.all([
    tenantIds.length > 0
      ? db.select({ tenantId: wallets.tenantId, balance: wallets.balance }).from(wallets).where(inArray(wallets.tenantId, tenantIds))
      : Promise.resolve([]),
    planIds.length > 0
      ? db.select({ id: plans.id, name: plans.name }).from(plans).where(inArray(plans.id, planIds))
      : Promise.resolve([]),
  ]);
  const planNameMap = Object.fromEntries(allPlans.map((p) => [p.id, p.name]));
  const data = rows.map((r) => ({
    ...r,
    walletBalance: Number(allWallets.find((w) => w.tenantId === r.id)?.balance ?? 0),
    planName: r.planId ? planNameMap[r.planId] ?? null : null,
  }));

  const result = paginatedResponse(data, Number(total), raw);
  await cacheSet(cacheKey, result, 30);
  return c.json(result);
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(tenants).where(and(eq(tenants.id, c.req.param('id')), isNull(tenants.deletedAt)));
  if (!row) throw new NotFound('Tenant not found');
  const [wallet] = await db.select().from(wallets).where(eq(wallets.tenantId, row.id));
  const [plan] = row.planId ? await db.select({ name: plans.name }).from(plans).where(eq(plans.id, row.planId)) : [];
  // Surface the tenant's primary admin user so the edit modal can show "The admin email is …"
  const [admin] = await db.select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(and(eq(users.tenantId, row.id), eq(users.role, 'tenant_admin'), isNull(users.deletedAt)))
    .orderBy(users.createdAt)
    .limit(1);
  return c.json({
    ...row,
    wallet: wallet ?? null,
    planName: plan?.name ?? null,
    adminId: admin?.id ?? null,
    adminEmail: admin?.email ?? null,
    adminFirstName: admin?.firstName ?? null,
    adminLastName: admin?.lastName ?? null,
  });
});

router.post('/', async (c) => {
  const body = createTenantSchema.parse(await c.req.json());
  const { adminEmail, adminFirstName, adminLastName, adminPassword, ...tenantData } = body;

  // Check for duplicate admin email
  const [existingEmail] = await db.select({ id: users.id }).from(users).where(eq(users.email, adminEmail));
  if (existingEmail) throw new BadRequest('Admin email already exists');

  const [tenant] = await db.insert(tenants).values(tenantData).returning();

  const passwordHash = await hashPassword(adminPassword);
  const [adminUser] = await db.insert(users).values({
    tenantId: tenant.id,
    email: adminEmail,
    passwordHash,
    firstName: adminFirstName,
    lastName: adminLastName,
    role: 'tenant_admin',
  }).returning();

  const [wallet] = await db.insert(wallets).values({ tenantId: tenant.id }).returning();

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`tenants:*`);
  return c.json({ tenant, adminUser, wallet }, 201);
});

router.put('/:id', async (c) => {
  const body = updateTenantSchema.parse(await c.req.json());
  // Drop explicit-null fields so notNull columns (e.g. slug) don't get rejected
  const cleaned = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
  const [row] = await db.update(tenants).set({ ...cleaned, updatedAt: new Date() })
    .where(and(eq(tenants.id, c.req.param('id')), isNull(tenants.deletedAt))).returning();
  if (!row) throw new NotFound('Tenant not found');
  const [plan] = row.planId ? await db.select({ name: plans.name }).from(plans).where(eq(plans.id, row.planId)) : [];
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`tenants:*`);
  return c.json({ ...row, planName: plan?.name ?? null });
});

// Reset tenant admin password
router.put('/:id/reset-password', async (c) => {
  const tenantId = c.req.param('id');
  const body = z.object({ password: z.string().min(8) }).parse(await c.req.json());
  const [admin] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, 'tenant_admin'), isNull(users.deletedAt)))
    .limit(1);
  if (!admin) throw new NotFound('Tenant admin not found');
  const passwordHash = await hashPassword(body.password);
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, admin.id));
  return c.json({ ok: true });
});

router.delete('/:id', async (c) => {
  const [row] = await db.update(tenants).set({ deletedAt: new Date() })
    .where(and(eq(tenants.id, c.req.param('id')), isNull(tenants.deletedAt))).returning();
  if (!row) throw new NotFound('Tenant not found');
  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`tenants:*`);
  return c.json({ ok: true });
});

router.post('/:id/credit', async (c) => {
  const tenantId = c.req.param('id');
  const body = creditSchema.parse(await c.req.json());

  const result = await db.transaction(async (tx) => {
    const walletRows = await tx.execute(sql`SELECT * FROM wallets WHERE tenant_id = ${tenantId} FOR UPDATE`);
    const wallet = walletRows[0] as typeof wallets.$inferSelect | undefined;
    if (!wallet) throw new NotFound('Wallet not found');

    const newBalance = Number(wallet.balance) + body.amount;
    const [updated] = await tx.update(wallets).set({ balance: String(newBalance), updatedAt: new Date() })
      .where(eq(wallets.id, wallet.id)).returning();

    await tx.insert(transactions).values({
      tenantId,
      walletId: wallet.id,
      type: 'credit',
      amount: String(body.amount),
      balanceAfter: String(newBalance),
      description: body.description ?? 'Manual credit',
      reference: body.reference,
    });

    return { wallet: updated };
  });

  const { cacheDelPattern } = await import('../../lib/redis');
  await cacheDelPattern(`tenants:*`);
  return c.json(result);
});

export default router;
