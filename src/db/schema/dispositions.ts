import { pgTable, uuid, text, boolean, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const dispositions = pgTable('dispositions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  code: text('code').notNull(),
  label: text('label').notNull(),
  category: text('category').notNull(),
  autoDnc: boolean('auto_dnc').default(false),
  isCompleted: boolean('is_completed').default(false),
  requiresNote: boolean('requires_note').default(false),
  requiresCallback: boolean('requires_callback').default(false),
  isSystem: boolean('is_system').default(false),
  enabled: boolean('enabled').default(true),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
