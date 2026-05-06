-- Voice broadcast: voicemail variant audio for amd_action='leave_voicemail'.
-- When AMD classifies the called party as a machine, mod_avmd waits for the
-- beep and then plays this audio (different from the human-branch audio which
-- comes from broadcast_audio_id).
-- Apply with: psql $DATABASE_URL -f drizzle/migrations/0019_campaigns_vm_audio.sql
-- Safe in production: additive, nullable, no backfill needed.

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "vm_audio_id" uuid;
