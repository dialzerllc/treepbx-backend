import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const dncEntries = pgTable('dnc_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  phone: text('phone').notNull(),
  reason: text('reason'),
  source: text('source').default('manual'),
  addedBy: uuid('added_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique('uq_dnc_phone').on(table.tenantId, table.phone),
]);
