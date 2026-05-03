import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { leadLists } from './lead-lists';

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  leadListId: uuid('lead_list_id').notNull().references(() => leadLists.id),
  phone: text('phone').notNull(),
  altPhone: text('alt_phone'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),
  company: text('company'),
  timezone: text('timezone'),
  customFields: jsonb('custom_fields').default({}),
  tags: text('tags').array().default([]),
  notes: text('notes'),
  source: text('source').default('manual'),
  priority: integer('priority').default(5),
  dnc: boolean('dnc').default(false),
  dncReason: text('dnc_reason'),
  attempts: integer('attempts').default(0),
  maxAttempts: integer('max_attempts').default(3),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastDisposition: text('last_disposition'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  assignedAgentId: uuid('assigned_agent_id'),
  status: text('status').default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_leads_tenant_list').on(table.tenantId, table.leadListId),
  index('idx_leads_phone').on(table.tenantId, table.phone),
  index('idx_leads_status').on(table.tenantId, table.status, table.nextAttemptAt),
  // Dedupe re-uploads of the same phone into the same list. Different lists
  // (e.g. "Old leads" + "New campaign") may legitimately hold the same phone.
  uniqueIndex('uq_leads_tenant_list_phone').on(table.tenantId, table.leadListId, table.phone),
]);
