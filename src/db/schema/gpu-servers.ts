import { pgTable, uuid, text, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';

export const gpuServers = pgTable('gpu_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  providerId: text('provider_id'),
  name: text('name').notNull(),
  host: text('host').notNull(),
  gpuType: text('gpu_type').notNull(),
  services: text('services').array().default([]),
  status: text('status').default('offline'),
  gpuUtilization: numeric('gpu_utilization', { precision: 5, scale: 2 }),
  isDefault: boolean('is_default').default(false),
  lastHealthCheck: timestamp('last_health_check', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
