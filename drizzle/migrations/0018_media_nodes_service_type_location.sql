-- Add service_type and location columns to media_nodes.
-- service_type lets the autoscaler distinguish freeswitch / media / sip_proxy / db / etc.
-- location pins each node to a Hetzner location for region-aware planning.
-- Both use IF NOT EXISTS so the migration is safe on DBs that already gained the columns out-of-band.
ALTER TABLE "media_nodes" ADD COLUMN IF NOT EXISTS "service_type" text NOT NULL DEFAULT 'freeswitch';
ALTER TABLE "media_nodes" ADD COLUMN IF NOT EXISTS "location" text;
