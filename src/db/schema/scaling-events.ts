import { pgTable, uuid, text, integer, numeric, timestamp } from 'drizzle-orm/pg-core';

export const scalingEvents = pgTable('scaling_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  scalingRuleId: uuid('scaling_rule_id'),
  action: text('action').notNull(),
  serviceType: text('service_type').notNull(),
  fromInstances: integer('from_instances').notNull(),
  toInstances: integer('to_instances').notNull(),
  triggerMetric: text('trigger_metric'),
  triggerValue: numeric('trigger_value', { precision: 12, scale: 4 }),
  serverType: text('server_type'),
  location: text('location'),
  durationMs: integer('duration_ms'),
  status: text('status').default('pending'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
