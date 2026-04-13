import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { calls, wallets, transactions } from '../db/schema';
import { logger } from '../lib/logger';

interface BillingJob {
  callId: string;
  tenantId: string;
  durationSeconds: number;
  ratePerMinute: string;
}

export async function processBilling(job: Job<BillingJob>) {
  const { callId, tenantId, durationSeconds, ratePerMinute } = job.data;
  logger.info({ callId }, 'Processing call billing');

  const rate = parseFloat(ratePerMinute);
  const billingSeconds = Math.ceil(durationSeconds / 6) * 6; // 6-second billing increment
  const cost = (billingSeconds / 60) * rate;

  // Atomic wallet debit
  const [wallet] = await db.select().from(wallets).where(eq(wallets.tenantId, tenantId));
  if (!wallet) {
    logger.error({ tenantId }, 'No wallet found for tenant');
    return;
  }

  const newBalance = parseFloat(wallet.balance) - cost;

  await db.update(wallets).set({
    balance: String(newBalance),
    updatedAt: new Date(),
  }).where(eq(wallets.id, wallet.id));

  await db.insert(transactions).values({
    tenantId,
    walletId: wallet.id,
    type: 'debit',
    amount: String(-cost),
    balanceAfter: String(newBalance),
    description: `Call charge: ${billingSeconds}s @ $${rate}/min`,
    reference: callId,
    metadata: { callId, durationSeconds, billingSeconds, rate },
  });

  // Update call record with cost
  await db.update(calls).set({
    cost: String(cost),
    billingSeconds,
    ratePerMinute: String(rate),
  }).where(eq(calls.id, callId));

  logger.info({ callId, cost, billingSeconds }, 'Call billed');
}
