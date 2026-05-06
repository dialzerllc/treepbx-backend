-- AI screen campaign mode — fields read by ai-screen.lua + ai-probe route.
--   probe_prompt_text       — what the bot says ("Hi, am I speaking with John?").
--   probe_prompt_audio_id   — pre-rendered TTS audio uploaded to R2 by the
--                             campaign save hook so we don't re-synthesize per call.
--   probe_eval_prompt       — system prompt for the LLM verdict on the called
--                             party's response. Tenant-overridable; default is
--                             populated by the API on insert if not supplied.
-- Apply with: psql $DATABASE_URL -f drizzle/migrations/0020_campaigns_ai_screen.sql
-- Safe in production: additive, all nullable.

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "probe_prompt_text" text;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "probe_prompt_audio_id" uuid;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "probe_eval_prompt" text;
