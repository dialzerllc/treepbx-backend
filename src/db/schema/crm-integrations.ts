import { pgTable, uuid, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const crmIntegrations = pgTable('crm_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  syncDirection: text('sync_direction').default('bidirectional'),
  status: text('status').default('active'),
  credentials: jsonb('credentials').default({}),
  config: jsonb('config').default({}),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  contactsSynced: integer('contacts_synced').default(0),
  callsSynced: integer('calls_synced').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
