CREATE TABLE "service_metric_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"answer_time_seconds" integer DEFAULT 20,
	"service_level_pct" integer DEFAULT 80,
	"max_wait_seconds" integer DEFAULT 120,
	"max_abandon_pct" integer DEFAULT 5,
	"avg_handle_time_seconds" integer DEFAULT 300,
	"avg_wrap_time_seconds" integer DEFAULT 30,
	"min_answer_rate_pct" integer DEFAULT 90,
	"assigned_type" text DEFAULT 'global',
	"assigned_id" uuid,
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "service_metric_targets" ADD CONSTRAINT "service_metric_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;