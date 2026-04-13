import { pgTable, uuid, text, integer, numeric, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const voicebotConfigs = pgTable('voicebot_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  ollamaModel: text('ollama_model').default('llama3'),
  engineStt: text('engine_stt').default('whisper'),
  engineTts: text('engine_tts').default('piper'),
  ttsVoice: text('tts_voice').default('en-US-male'),
  systemPrompt: text('system_prompt'),
  maxTurns: integer('max_turns').default(10),
  tone: text('tone').default('professional'),
  language: text('language').default('en'),
  temperature: numeric('temperature', { precision: 3, scale: 2 }).default('0.7'),
  guardrails: jsonb('guardrails').default({}),
  status: text('status').default('untrained'),
  lastTrainedAt: timestamp('last_trained_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
