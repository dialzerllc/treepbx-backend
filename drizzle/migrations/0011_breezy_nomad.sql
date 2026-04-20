ALTER TABLE "carriers" ADD COLUMN "reachable" boolean;--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "last_checked" timestamp with time zone;