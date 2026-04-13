import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { voicebotConfigs } from './voicebot-configs';

export const voicebotFlows = pgTable('voicebot_flows', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  voicebotConfigId: uuid('voicebot_config_id').notNull().references(() => voicebotConfigs.id),
  name: text('name').notNull(),
  botMessage: text('bot_message').notNull(),
  expectedResponses: text('expected_responses').array().default([]),
  nextFlowId: uuid('next_flow_id'),
  stepOrder: integer('step_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
