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
  // SLA
  slaUptimePct: numeric('sla_uptime_pct', { precision: 5, scale: 2 }).default('99.90'),
  slaResponseMinutes: integer('sla_response_minutes').default(60),
  slaResolutionHours: integer('sla_resolution_hours').default(24),
  slaSupportHours: text('sla_support_hours').default('business'),
  slaPriorityRouting: boolean('sla_priority_routing').default(false),
  slaDedicatedManager: boolean('sla_dedicated_manager').default(false),
  slaCustomIntegrations: boolean('sla_custom_integrations').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
