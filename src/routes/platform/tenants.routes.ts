import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, like, desc, count, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { tenants, users, wallets, transactions } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { hashPassword } from '../../lib/password';

const router = new Hono();

const createTenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  planId: z.string().uuid().optional(),
  status: z.enum(['trial', 'active', 'suspended', 'cancelled']).default('trial'),
  billingEmail: z.string().email().optional(),
  timezone: z.string().default('UTC'),
  country: z.string().default('US'),
  adminEmail: z.string().email(),
  adminFirstName: z.string().min(1),
  adminLastName: z.string().min(1),
  adminPassword: z.string().min(8),
});

const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['trial', 'active', 'suspended', 'cancelled']).optional(),
  planId: z.string().uuid().nullable().optional(),
  maxAgents: z.number().int().positive().optional(),
  maxConcurrentCalls: z.number().int().positive().optional(),
  maxDids: z.number().int().positive().optional(),
  billingEmail: z.string().email().optional(),
  timezone: z.string().optional(),
  domain: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  features: z.record(z.unknown()).optional(),
});

const creditSchema = z.object({
  amount: z.number().positive(),
  description: z.string().optional(),
  reference: z.string().optional(),
});

router.get('/', async (c) => {
  const raw = paginationSchema.extend({
    status: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions = [isNull(tenants.deletedAt)];
  if (raw.search) conditions.push(like(tenants.name, `%${raw.search}%`));
  if (raw.status) conditions.push(eq(tenants.status, raw.status));

  const where = and(...conditions);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(tenants).where(where).orderBy(desc(tenants.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(tenants).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

router.get('/:id', async (c) => {
  const [row] = await db.select().from(tenants).where(and(eq(tenants.id, c.req.param('id')), isNull(tenants.deletedAt)));
  if (!row) throw new NotFound('Tenant not found');
  const [wallet] = await db.select().from(wallets).where(eq(wallets.tenantId, row.id));
  return c.json({ ...row, wallet: wallet ?? null });
});

router.post('/', async (c) => {
  const body = createTenantSchema.parse(await c.req.json());
  const { adminEmail, adminFirstName, adminLastName, adminPassword, ...tenantData } = body;

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

  return c.json({ tenant, adminUser, wallet }, 201);
});

router.put('/:id', async (c) => {
  const body = updateTenantSchema.parse(await c.req.json());
  const [row] = await db.update(tenants).set({ ...body, updatedAt: new Date() })
    .where(and(eq(tenants.id, c.req.param('id')), isNull(tenants.deletedAt))).returning();
  if (!row) throw new NotFound('Tenant not found');
  return c.json(row);
});

router.delete('/:id', async (c) => {
  const [row] = await db.update(tenants).set({ deletedAt: new Date() })
    .where(and(eq(tenants.id, c.req.param('id')), isNull(tenants.deletedAt))).returning();
  if (!row) throw new NotFound('Tenant not found');
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

  return c.json(result);
});

export default router;
