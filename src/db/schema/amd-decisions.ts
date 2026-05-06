import { pgTable, uuid, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { campaigns } from './campaigns';
import { calls } from './calls';

/**
 * amd_decisions — append-only audit log of every AMD/AI-screen decision made
 * for a campaign call. One row per call where AMD or ai-screen ran.
 *
 * Built primarily for TCPA-compliance defense: a regulator (or plaintiff
 * counsel) can ask "did you reasonably believe this was a human when you
 * bridged?" and we can produce the timestamped row + the audio sample of the
 * called party's answer + the LLM's reasoning. Without that evidence, you
 * are exposed; with it, the litigation cost drops dramatically.
 *
 * Append-only by convention — there is no UPDATE path in the route layer.
 * Existing rows must not be mutated for evidentiary integrity.
 */
export const amdDecisions = pgTable('amd_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  callId: uuid('call_id').references(() => calls.id),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  tenantId: uuid('tenant_id').references(() => tenants.id),

  // Source: 'avmd' (mod_avmd binary classifier) or 'ai_screen' (probe + STT + LLM).
  source: text('source').notNull(),

  // Final classification + action taken on the channel.
  amdResult: text('amd_result'), // 'human' | 'machine' | 'unknown'
  action: text('action'),         // 'bridge' | 'hangup' | 'transfer' | 'voicemail' | 'play_message'

  // Evidence:
  audioKey: text('audio_key'),    // R2 key of the answer-phase capture (8s after pickup).
  probeText: text('probe_text'),  // What the bot said (ai_screen only).
  transcript: text('transcript'), // STT output (ai_screen only).
  reason: text('reason'),         // LLM 1-line justification, or avmd reason string.
  llmRaw: text('llm_raw'),        // Full LLM output for ai_screen — debugging + drift detection.

  // Timing (milliseconds since channel answered):
  decidedAtMs: integer('decided_at_ms'),  // when classification was made
  totalLatencyMs: integer('total_latency_ms'),  // total round-trip (record + STT + LLM)

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_amd_decisions_call').on(table.callId),
  index('idx_amd_decisions_campaign').on(table.campaignId, table.createdAt),
  index('idx_amd_decisions_tenant').on(table.tenantId, table.createdAt),
]);
