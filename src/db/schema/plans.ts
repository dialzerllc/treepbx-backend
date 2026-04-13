import { pgTable, uuid, text, numeric, integer, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  priceMonthly: numeric('price_monthly', { precision: 10, scale: 2 }).notNull(),
  priceYearly: numeric('price_yearly', { precision: 10, scale: 2 }).notNull(),
  maxAgents: integer('max_agents').notNull(),
  maxConcurrentCalls: integer('max_concurrent_calls').notNull(),
  maxDids: integer('max_dids').notNull(),
  rateGroupId: uuid('rate_group_id'),
  includedCredit: numeric('included_credit', { precision: 10, scale: 2 }).default('0'),
  features: jsonb('features').default([]),
  popular: boolean('popular').default(false),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
