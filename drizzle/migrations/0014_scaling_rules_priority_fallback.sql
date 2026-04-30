-- Phase A: scaling_rules — add priority + fallback_location fields
-- Apply with: psql $DATABASE_URL -f drizzle/migrations/0014_scaling_rules_priority_fallback.sql
-- Safe to run in production (additive, all columns have defaults; no backfill).

ALTER TABLE "scaling_rules" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 100 NOT NULL;
ALTER TABLE "scaling_rules" ADD COLUMN IF NOT EXISTS "fallback_strategy" text DEFAULT 'region' NOT NULL;
ALTER TABLE "scaling_rules" ADD COLUMN IF NOT EXISTS "fallback_location" text;

CREATE INDEX IF NOT EXISTS "scaling_rules_priority_idx" ON "scaling_rules" ("priority");
