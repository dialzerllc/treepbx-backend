import { pgTable, uuid, text, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const agentSkills = pgTable('agent_skills', {
  agentId: uuid('agent_id').notNull().references(() => users.id),
  skillId: uuid('skill_id').notNull().references(() => skills.id),
  proficiency: integer('proficiency').default(1),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.skillId] }),
]);
