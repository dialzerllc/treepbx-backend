-- amd_decisions audit table — TCPA-compliance evidence per call where AMD ran.
-- Append-only by convention; no UPDATE path in route layer.
-- Apply with: psql $DATABASE_URL -f drizzle/migrations/0021_amd_decisions.sql

CREATE TABLE IF NOT EXISTS "amd_decisions" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "call_id"         uuid REFERENCES "calls"("id"),
  "campaign_id"     uuid REFERENCES "campaigns"("id"),
  "tenant_id"       uuid REFERENCES "tenants"("id"),
  "source"          text NOT NULL,
  "amd_result"      text,
  "action"          text,
  "audio_key"       text,
  "probe_text"      text,
  "transcript"      text,
  "reason"          text,
  "llm_raw"         text,
  "decided_at_ms"   integer,
  "total_latency_ms" integer,
  "created_at"      timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_amd_decisions_call"     ON "amd_decisions" ("call_id");
CREATE INDEX IF NOT EXISTS "idx_amd_decisions_campaign" ON "amd_decisions" ("campaign_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_amd_decisions_tenant"   ON "amd_decisions" ("tenant_id", "created_at");
