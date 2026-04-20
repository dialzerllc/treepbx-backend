ALTER TABLE "plans" ADD COLUMN "sla_uptime_pct" numeric(5, 2) DEFAULT '99.90';--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "sla_response_minutes" integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "sla_resolution_hours" integer DEFAULT 24;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "sla_support_hours" text DEFAULT 'business';--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "sla_priority_routing" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "sla_dedicated_manager" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "sla_custom_integrations" boolean DEFAULT false;