import { pgTable, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';
import { dids } from './dids';

export const agentDids = pgTable('agent_dids', {
  agentId: uuid('agent_id').notNull().references(() => users.id),
  didId: uuid('did_id').notNull().references(() => dids.id),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.didId] }),
]);
