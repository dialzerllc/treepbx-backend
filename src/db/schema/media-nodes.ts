import { pgTable, uuid, text, integer, real, timestamp, bigint, index } from 'drizzle-orm/pg-core';

/**
 * A registered FreeSWITCH media node the autoscaler knows about.
 * Rows transition: provisioning → registering → active → draining → terminating → (deleted)
 */
export const mediaNodes = pgTable('media_nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  hetznerId: bigint('hetzner_id', { mode: 'number' }).unique().notNull(),
  pool: text('pool').notNull(),                 // 'baseline' | 'hot_spare' | 'elastic'
  serverType: text('server_type').notNull(),    // 'cpx31' | 'ccx33' etc.
  publicIp: text('public_ip').notNull(),
  privateIp: text('private_ip'),
  capacityCc: integer('capacity_cc').notNull(),
  imageVersion: text('image_version').notNull(),
  state: text('state').notNull(),                // see comment above
  activeCalls: integer('active_calls').notNull().default(0),
  cpuPct: real('cpu_pct'),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  drainStartedAt: timestamp('drain_started_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  index('idx_media_nodes_state').on(t.state),
  index('idx_media_nodes_pool').on(t.pool),
]);

/**
 * Per-event autoscaler decisions. Useful both for shadow-mode review and for
 * post-incident root cause analysis ("why did we provision 5 nodes at 3am?").
 */
export const scalingDecisions = pgTable('scaling_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),             // 'provision' | 'drain' | 'destroy' | 'skip' | 'shadow'
  nodeId: uuid('node_id'),                  // nullable — shadow/skip events have no node
  reason: text('reason'),
  targetCc: integer('target_cc'),
  currentCc: integer('current_cc'),
  carrierCeiling: integer('carrier_ceiling'),
  shadowMode: text('shadow_mode').default('false'),
  at: timestamp('at', { withTimezone: true }).defaultNow(),
}, (t) => [
  index('idx_scaling_decisions_at').on(t.at),
]);

/**
 * Key-value settings table for platform-wide flags the autoscaler and related
 * components read at runtime. Use for toggles like autoscaler_enabled, and for
 * pointers like active_media_image_id.
 */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
