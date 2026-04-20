import { pgTable, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';
import { leadLists } from './lead-lists';

export const agentLeadLists = pgTable('agent_lead_lists', {
  agentId: uuid('agent_id').notNull().references(() => users.id),
  leadListId: uuid('lead_list_id').notNull().references(() => leadLists.id),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.leadListId] }),
]);
