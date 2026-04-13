import { pgTable, uuid, text, boolean, time, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const businessHours = pgTable('business_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  enabled: boolean('enabled').default(true),
  startTime: time('start_time'),
  endTime: time('end_time'),
  days: text('days').array().default([]),
  timezone: text('timezone').default('America/New_York'),
  routeType: text('route_type'),
  routeTargetId: uuid('route_target_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
