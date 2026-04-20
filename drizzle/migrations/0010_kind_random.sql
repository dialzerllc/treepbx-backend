ALTER TABLE "carriers" ADD COLUMN "registration_status" text DEFAULT 'unregistered';--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "registration_user" text;--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "registration_expiry" integer;--> statement-breakpoint
ALTER TABLE "carriers" ADD COLUMN "last_registered" timestamp with time zone;