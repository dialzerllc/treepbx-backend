import { pgTable, uuid, text, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const platformDids = pgTable('platform_dids', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: text('number').unique().notNull(),
  provider: text('provider').notNull(),
  city: text('city'),
  state: text('state'),
  country: text('country').default('US'),
  didType: text('did_type').default('local'),
  monthlyCost: numeric('monthly_cost', { precision: 8, scale: 4 }).default('0'),
  status: text('status').default('available'),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  groupId: uuid('group_id'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const platformDidGroups = pgTable('platform_did_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  isDefault: boolean('is_default').default(false),
  visibleToAll: boolean('visible_to_all').default(true),
  assignedTenantId: uuid('assigned_tenant_id').references(() => tenants.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
