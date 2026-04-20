ALTER TABLE "service_metric_targets" ADD COLUMN "max_hold_time_seconds" integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE "service_metric_targets" ADD COLUMN "max_ring_time_seconds" integer DEFAULT 30;--> statement-breakpoint
ALTER TABLE "service_metric_targets" ADD COLUMN "min_occupancy_pct" integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE "service_metric_targets" ADD COLUMN "max_idle_time_seconds" integer DEFAULT 300;--> statement-breakpoint
ALTER TABLE "service_metric_targets" ADD COLUMN "min_mos_score" numeric(3, 1) DEFAULT '3.5';--> statement-breakpoint
ALTER TABLE "service_metric_targets" ADD COLUMN "max_calls_per_hour" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "service_metric_targets" ADD COLUMN "first_call_resolution_pct" integer DEFAULT 70;