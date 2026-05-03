CREATE TABLE "agent_lead_lists" (
	"agent_id" uuid NOT NULL,
	"lead_list_id" uuid NOT NULL,
	CONSTRAINT "agent_lead_lists_agent_id_lead_list_id_pk" PRIMARY KEY("agent_id","lead_list_id")
);
--> statement-breakpoint
CREATE TABLE "chat_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_type" text NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uniq_reaction_per_user_emoji" UNIQUE("message_type","message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "chat_read_markers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid,
	"conversation_id" uuid,
	"last_read_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "chat_read_markers_user_id_channel_id_unique" UNIQUE("user_id","channel_id"),
	CONSTRAINT "chat_read_markers_user_id_conversation_id_unique" UNIQUE("user_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "contact_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text,
	"agents" text,
	"message" text,
	"ip" text,
	"user_agent" text,
	"consent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dm_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "dm_conversations_user_a_user_b_unique" UNIQUE("user_a","user_b")
);
--> statement-breakpoint
CREATE TABLE "dm_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"content" text NOT NULL,
	"parent_id" uuid,
	"file_url" text,
	"file_name" text,
	"file_size" integer,
	"file_type" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "media_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hetzner_id" bigint NOT NULL,
	"pool" text NOT NULL,
	"server_type" text NOT NULL,
	"public_ip" text NOT NULL,
	"private_ip" text,
	"capacity_cc" integer NOT NULL,
	"image_version" text NOT NULL,
	"state" text NOT NULL,
	"active_calls" integer DEFAULT 0 NOT NULL,
	"cpu_pct" real,
	"last_heartbeat_at" timestamp with time zone,
	"drain_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "media_nodes_hetzner_id_unique" UNIQUE("hetzner_id")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scaling_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"node_id" uuid,
	"scaling_rule_id" uuid,
	"reason" text,
	"target_cc" integer,
	"current_cc" integer,
	"carrier_ceiling" integer,
	"shadow_mode" text DEFAULT 'false',
	"at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "lead_lists" DROP CONSTRAINT "lead_lists_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "codec" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "sip_from_uri" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "sip_to_uri" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "lead_list_ids" text[] DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "lead_list_strategy" text DEFAULT 'sequential';--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "caller_id_rotation" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "byoc_carriers" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "retry_failed_leads" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "stir_certificate_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "file_url" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "file_size" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "file_type" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead_lists" ADD COLUMN "is_default" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "lead_lists" ADD COLUMN "assignment_type" text;--> statement-breakpoint
ALTER TABLE "lead_lists" ADD COLUMN "assigned_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "scaling_rules" ADD COLUMN IF NOT EXISTS "warm_spare" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_lead_lists" ADD CONSTRAINT "agent_lead_lists_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lead_lists" ADD CONSTRAINT "agent_lead_lists_lead_list_id_lead_lists_id_fk" FOREIGN KEY ("lead_list_id") REFERENCES "public"."lead_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reactions" ADD CONSTRAINT "chat_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_read_markers" ADD CONSTRAINT "chat_read_markers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_conversation_id_dm_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."dm_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_reactions_message" ON "chat_reactions" USING btree ("message_type","message_id");--> statement-breakpoint
CREATE INDEX "idx_contact_submissions_email" ON "contact_submissions" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "idx_contact_submissions_ip" ON "contact_submissions" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "idx_dm_messages_conv" ON "dm_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_media_nodes_state" ON "media_nodes" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_media_nodes_pool" ON "media_nodes" USING btree ("pool");--> statement-breakpoint
CREATE INDEX "idx_scaling_decisions_at" ON "scaling_decisions" USING btree ("at");--> statement-breakpoint
CREATE INDEX "idx_calls_status" ON "calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_calls_caller" ON "calls" USING btree ("caller_id");--> statement-breakpoint
CREATE INDEX "idx_calls_callee" ON "calls" USING btree ("callee_number");--> statement-breakpoint
ALTER TABLE "lead_lists" DROP COLUMN "dial_mode";--> statement-breakpoint
ALTER TABLE "lead_lists" DROP COLUMN "max_attempts";--> statement-breakpoint
ALTER TABLE "lead_lists" DROP COLUMN "retry_delay_minutes";--> statement-breakpoint
ALTER TABLE "lead_lists" DROP COLUMN "priority";--> statement-breakpoint
ALTER TABLE "lead_lists" DROP COLUMN "campaign_id";