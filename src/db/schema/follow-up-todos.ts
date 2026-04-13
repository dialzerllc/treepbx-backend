import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const followUpTodos = pgTable('follow_up_todos', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  agentId: uuid('agent_id').notNull().references(() => users.id),
  leadId: uuid('lead_id'),
  leadName: text('lead_name'),
  leadPhone: text('lead_phone'),
  reason: text('reason'),
  priority: text('priority').default('medium'),
  dueDate: timestamp('due_date', { withTimezone: true }).notNull(),
  completed: boolean('completed').default(false),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
