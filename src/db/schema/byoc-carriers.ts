import { pgTable, uuid, text, integer, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const byocCarriers = pgTable('byoc_carriers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').default(5060),
  transport: text('transport').default('UDP'),
  codec: text('codec').default('G.711'),
  username: text('username'),
  passwordHash: text('password_hash'),
  maxChannels: integer('max_channels').default(50),
  ratePerMinute: numeric('rate_per_minute', { precision: 8, scale: 6 }),
  status: text('status').default('testing'),
  registered: boolean('registered').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
