ALTER TABLE "teams" ADD COLUMN "script_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "skills" text[] DEFAULT '{}';