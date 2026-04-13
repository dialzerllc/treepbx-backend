import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const didGroups = pgTable('did_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  strategy: text('strategy').default('round_robin'),
  defaultRoute: text('default_route'),
  callerIdStrategy: text('caller_id_strategy').default('fixed'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
