import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const scheduleEvents = pgTable('schedule_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  type: text('type').notNull(),
  status: text('status').default('upcoming'),
  title: text('title').notNull(),
  description: text('description'),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }).notNull(),
  leadId: uuid('lead_id'),
  leadName: text('lead_name'),
  leadPhone: text('lead_phone'),
  priority: text('priority').default('medium'),
  campaignId: uuid('campaign_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_schedule_user').on(table.userId, table.startTime),
]);
