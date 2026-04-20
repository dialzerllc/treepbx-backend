import { pgTable, uuid, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const leadLists = pgTable('lead_lists', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  source: text('source').default('manual'),
  leadCount: integer('lead_count').default(0),
  dialedCount: integer('dialed_count').default(0),
  status: text('status').default('active'),
  timezone: text('timezone'),
  isDefault: boolean('is_default').default(false),
  assignmentType: text('assignment_type'),
  assignedCampaignId: uuid('assigned_campaign_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
