import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { campaigns } from './campaigns';

export const leadLists = pgTable('lead_lists', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  source: text('source').default('manual'),
  leadCount: integer('lead_count').default(0),
  dialedCount: integer('dialed_count').default(0),
  status: text('status').default('active'),
  dialMode: text('dial_mode'),
  maxAttempts: integer('max_attempts').default(3),
  retryDelayMinutes: integer('retry_delay_minutes').default(60),
  priority: integer('priority').default(5),
  timezone: text('timezone'),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
