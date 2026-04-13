import { pgTable, uuid, text, integer, numeric, bigint, timestamp } from 'drizzle-orm/pg-core';

export const hetznerServers = pgTable('hetzner_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  hetznerId: bigint('hetzner_id', { mode: 'number' }).unique(),
  name: text('name').notNull(),
  serverType: text('server_type').notNull(),
  location: text('location').notNull(),
  role: text('role').notNull(),
  status: text('status').default('provisioning'),
  ipPublic: text('ip_public'),
  ipPrivate: text('ip_private'),
  vcpus: integer('vcpus'),
  ramGb: integer('ram_gb'),
  callsHandled: integer('calls_handled').default(0),
  cpuPercent: numeric('cpu_percent', { precision: 5, scale: 2 }),
  memPercent: numeric('mem_percent', { precision: 5, scale: 2 }),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }).default(0),
  lastHealthCheck: timestamp('last_health_check', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
