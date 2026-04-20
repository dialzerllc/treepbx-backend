import { pgTable, uuid, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';

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
  registrationStatus: text('registration_status').default('unregistered'),
  registrationUser: text('registration_user'),
  registrationExpiry: integer('registration_expiry'),
  lastRegistered: timestamp('last_registered', { withTimezone: true }),
  reachable: boolean('reachable'),
  lastChecked: timestamp('last_checked', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
