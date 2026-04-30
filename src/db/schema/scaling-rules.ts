import { pgTable, uuid, text, integer, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';

export const scalingRules = pgTable('scaling_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  serviceType: text('service_type').notNull(),
  serverType: text('server_type'),
  location: text('location'),
  metric: text('metric').notNull(),
  thresholdUp: numeric('threshold_up', { precision: 10, scale: 2 }).notNull(),
  thresholdDown: numeric('threshold_down', { precision: 10, scale: 2 }).notNull(),
  minInstances: integer('min_instances').default(1),
  maxInstances: integer('max_instances').default(10),
  cooldownSeconds: integer('cooldown_seconds').default(300),
  callsPerInstance: integer('calls_per_instance').default(0),
  warmSpare: integer('warm_spare').default(1).notNull(),
  priority: integer('priority').default(100).notNull(),
  fallbackStrategy: text('fallback_strategy').default('region').notNull(),
  fallbackLocation: text('fallback_location'),
  enabled: boolean('enabled').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const gpuScalingRules = pgTable('gpu_scaling_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  metric: text('metric').notNull(),
  thresholdUp: numeric('threshold_up', { precision: 10, scale: 2 }).notNull(),
  thresholdDown: numeric('threshold_down', { precision: 10, scale: 2 }).notNull(),
  minInstances: integer('min_instances').default(1),
  maxInstances: integer('max_instances').default(4),
  gpuType: text('gpu_type').notNull(),
  provider: text('provider').default('runpod'),
  enabled: boolean('enabled').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
