import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { wallets, transactions } from '../../db/schema';
import { paginationSchema, paginate, paginatedResponse } from '../../lib/pagination';
import { NotFound, BadRequest } from '../../lib/errors';
import { requireRole } from '../../middleware/roles';

const router = new Hono();

// Get wallet balance
router.get('/', async (c) => {
  const tenantId = c.get('tenantId')!;
  const [wallet] = await db.select().from(wallets).where(eq(wallets.tenantId, tenantId));
  if (!wallet) throw new NotFound('Wallet not found');
  return c.json(wallet);
});

// List transactions
router.get('/transactions', async (c) => {
  const tenantId = c.get('tenantId')!;
  const raw = paginationSchema.extend({
    type: z.string().optional(),
  }).parse(c.req.query());
  const { offset, limit } = paginate(raw);

  const conditions: any[] = [eq(transactions.tenantId, tenantId)];
  if (raw.type) conditions.push(eq(transactions.type, raw.type));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(transactions).where(where).orderBy(desc(transactions.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(transactions).where(where),
  ]);

  return c.json(paginatedResponse(rows, Number(total), raw));
});

// Top up wallet
router.post('/topup', requireRole('tenant_admin'), async (c) => {
  const tenantId = c.get('tenantId')!;
  const body = z.object({
    amount: z.number().positive(),
    description: z.string().optional(),
    reference: z.string().optional(),
    paymentMethod: z.string().optional(),
  }).parse(await c.req.json());

  // Use a transaction with SELECT FOR UPDATE to prevent race conditions
  const result = await db.transaction(async (tx) => {
    const walletRows = await tx.execute(sql`SELECT * FROM wallets WHERE tenant_id = ${tenantId} FOR UPDATE`);
    const wallet = walletRows[0] as typeof wallets.$inferSelect | undefined;
    if (!wallet) throw new NotFound('Wallet not found');

    const newBalance = Number(wallet.balance) + body.amount;

    const [updated] = await tx.update(wallets)
      .set({ balance: String(newBalance), updatedAt: new Date() })
      .where(eq(wallets.id, wallet.id))
      .returning();

    const [txRecord] = await tx.insert(transactions).values({
      tenantId,
      walletId: wallet.id,
      type: 'topup',
      amount: String(body.amount),
      balanceAfter: String(newBalance),
      description: body.description ?? 'Manual top-up',
      reference: body.reference,
    }).returning();

    return { wallet: updated, transaction: txRecord };
  });

  return c.json(result, 201);
});

export default router;
