import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';

export const carriers = pgTable('carriers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').default(5060),
  transport: text('transport').default('UDP'),
  direction: text('direction').default('both'),
  maxChannels: integer('max_channels').default(100),
  priority: integer('priority').default(1),
  status: text('status').default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
