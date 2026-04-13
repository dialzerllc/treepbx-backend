import { pgTable, uuid, text, numeric, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().unique().references(() => tenants.id),
  balance: numeric('balance', { precision: 12, scale: 4 }).notNull().default('0'),
  currency: text('currency').default('USD'),
  lowBalanceThreshold: numeric('low_balance_threshold', { precision: 12, scale: 4 }).default('10'),
  autoTopupEnabled: boolean('auto_topup_enabled').default(false),
  autoTopupAmount: numeric('auto_topup_amount', { precision: 12, scale: 4 }).default('100'),
  autoTopupThreshold: numeric('auto_topup_threshold', { precision: 12, scale: 4 }).default('5'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id),
  type: text('type').notNull(),
  amount: numeric('amount', { precision: 12, scale: 4 }).notNull(),
  balanceAfter: numeric('balance_after', { precision: 12, scale: 4 }).notNull(),
  description: text('description'),
  reference: text('reference'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_transactions_tenant').on(table.tenantId, table.createdAt),
]);
