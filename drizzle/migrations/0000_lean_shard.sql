CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"campaign_id" uuid,
	"login_at" timestamp with time zone DEFAULT now() NOT NULL,
	"logout_at" timestamp with time zone,
	"total_calls" integer DEFAULT 0,
	"total_talk_seconds" integer DEFAULT 0,
	"total_wrap_seconds" integer DEFAULT 0,
	"total_break_seconds" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"proficiency" integer DEFAULT 1,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}',
	"rate_limit" integer DEFAULT 1000,
	"active" boolean DEFAULT true,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audio_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"minio_key" text NOT NULL,
	"duration_seconds" numeric(8, 2),
	"format" text DEFAULT 'wav',
	"size_bytes" bigint,
	"source" text DEFAULT 'upload',
	"tts_text" text,
	"tts_voice" text,
	"category" text DEFAULT 'general',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"tenant_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"resource_label" text,
	"ip_address" text,
	"status_code" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"start_time" time,
	"end_time" time,
	"days" text[] DEFAULT '{}',
	"timezone" text DEFAULT 'America/New_York',
	"route_type" text,
	"route_target_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "byoc_carriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 5060,
	"transport" text DEFAULT 'UDP',
	"codec" text DEFAULT 'G.711',
	"username" text,
	"password_hash" text,
	"max_channels" integer DEFAULT 50,
	"rate_per_minute" numeric(8, 6),
	"status" text DEFAULT 'testing',
	"registered" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "call_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"minio_key" text NOT NULL,
	"format" text DEFAULT 'wav',
	"duration_seconds" integer,
	"size_bytes" bigint,
	"transcript" text,
	"transcript_status" text DEFAULT 'pending',
	"summary" text,
	"summary_status" text DEFAULT 'pending',
	"fraud_scan_status" text DEFAULT 'pending',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"freeswitch_uuid" text,
	"campaign_id" uuid,
	"lead_id" uuid,
	"agent_id" uuid,
	"did_id" uuid,
	"byoc_carrier_id" uuid,
	"direction" text NOT NULL,
	"caller_id" text NOT NULL,
	"caller_name" text,
	"callee_number" text NOT NULL,
	"callee_name" text,
	"status" text DEFAULT 'ringing' NOT NULL,
	"disposition" text,
	"hangup_cause" text,
	"amd_result" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"talk_time_seconds" integer,
	"hold_time_seconds" integer DEFAULT 0,
	"wait_time_seconds" integer DEFAULT 0,
	"wrap_time_seconds" integer DEFAULT 0,
	"recording_url" text,
	"recording_size_bytes" bigint,
	"cost" numeric(10, 6),
	"rate_per_minute" numeric(10, 6),
	"billing_seconds" integer,
	"has_transcript" boolean DEFAULT false,
	"has_summary" boolean DEFAULT false,
	"fraud_flagged" boolean DEFAULT false,
	"mos" numeric(4, 2),
	"jitter_ms" numeric(8, 2),
	"packet_loss_pct" numeric(5, 2),
	"carrier" text,
	"carrier_ip" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "calls_freeswitch_uuid_unique" UNIQUE("freeswitch_uuid")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft',
	"dial_mode" text DEFAULT 'progressive' NOT NULL,
	"lead_list_id" uuid,
	"did_group_id" uuid,
	"voicebot_config_id" uuid,
	"rate_card_id" uuid,
	"script_id" uuid,
	"dial_ratio" numeric(4, 2) DEFAULT '1.0',
	"max_abandon_rate" numeric(5, 2) DEFAULT '3.0',
	"wrap_up_seconds" integer DEFAULT 30,
	"ring_timeout_seconds" integer DEFAULT 25,
	"amd_enabled" boolean DEFAULT false,
	"amd_timeout_ms" integer DEFAULT 3500,
	"amd_action" text DEFAULT 'hangup',
	"amd_transfer_target" text,
	"recording_mode" text DEFAULT 'all',
	"recording_format" text DEFAULT 'wav',
	"byoc_routing" text DEFAULT 'platform',
	"byoc_carrier_id" uuid,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"dialing_days" text[] DEFAULT '{"Mon","Tue","Wed","Thu","Fri"}',
	"dialing_start_time" time DEFAULT '09:00',
	"dialing_end_time" time DEFAULT '17:00',
	"schedule_timezone" text DEFAULT 'America/New_York',
	"max_calls_per_day" integer DEFAULT 0,
	"max_attempts_per_lead" integer DEFAULT 3,
	"retry_delay_minutes" integer DEFAULT 60,
	"respect_lead_timezone" boolean DEFAULT true,
	"pause_on_holidays" boolean DEFAULT true,
	"disposition_required" boolean DEFAULT true,
	"enabled_dispositions" text[] DEFAULT '{}',
	"transfer_enabled" boolean DEFAULT false,
	"transfer_type" text DEFAULT 'blind',
	"transfer_dest_type" text DEFAULT 'external',
	"transfer_target" text,
	"bot_qualified_action" text,
	"bot_qualified_target" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "carriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 5060,
	"transport" text DEFAULT 'UDP',
	"direction" text DEFAULT 'both',
	"max_channels" integer DEFAULT 100,
	"priority" integer DEFAULT 1,
	"status" text DEFAULT 'active',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chat_channel_members" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "chat_channel_members_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'group',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"content" text NOT NULL,
	"attachment_url" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"sync_direction" text DEFAULT 'bidirectional',
	"status" text DEFAULT 'active',
	"credentials" jsonb DEFAULT '{}'::jsonb,
	"config" jsonb DEFAULT '{}'::jsonb,
	"last_sync_at" timestamp with time zone,
	"contacts_synced" integer DEFAULT 0,
	"calls_synced" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "did_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"strategy" text DEFAULT 'round_robin',
	"default_route" text,
	"caller_id_strategy" text DEFAULT 'fixed',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform_did_id" uuid,
	"number" text NOT NULL,
	"description" text,
	"country" text DEFAULT 'US',
	"city" text,
	"state" text,
	"did_type" text DEFAULT 'local',
	"did_group_id" uuid,
	"byoc_carrier_id" uuid,
	"active" boolean DEFAULT true,
	"route_type" text DEFAULT 'ivr',
	"route_target_id" uuid,
	"unknown_caller_route" text,
	"repeat_caller_route" text,
	"monthly_cost" numeric(8, 4) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"category" text NOT NULL,
	"auto_dnc" boolean DEFAULT false,
	"is_completed" boolean DEFAULT false,
	"requires_note" boolean DEFAULT false,
	"requires_callback" boolean DEFAULT false,
	"is_system" boolean DEFAULT false,
	"enabled" boolean DEFAULT true,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dnc_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"reason" text,
	"source" text DEFAULT 'manual',
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_dnc_phone" UNIQUE("tenant_id","phone")
);
--> statement-breakpoint
CREATE TABLE "follow_up_todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"lead_id" uuid,
	"lead_name" text,
	"lead_phone" text,
	"reason" text,
	"priority" text DEFAULT 'medium',
	"due_date" timestamp with time zone NOT NULL,
	"completed" boolean DEFAULT false,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fraud_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"call_id" uuid,
	"agent_id" uuid,
	"fraud_keyword_id" uuid,
	"keyword" text NOT NULL,
	"phrase_context" text,
	"severity" text NOT NULL,
	"caller" text,
	"source" text DEFAULT 'live',
	"status" text DEFAULT 'new',
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fraud_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"keyword" text NOT NULL,
	"category" text NOT NULL,
	"severity" text DEFAULT 'warning',
	"is_phrase" boolean DEFAULT false,
	"is_regex" boolean DEFAULT false,
	"notify_email" boolean DEFAULT true,
	"notify_sms" boolean DEFAULT false,
	"notify_webhook" boolean DEFAULT false,
	"notify_in_app" boolean DEFAULT true,
	"escalate_to_supervisor" boolean DEFAULT false,
	"auto_record_call" boolean DEFAULT false,
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "gpu_scaling_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"threshold_up" numeric(10, 2) NOT NULL,
	"threshold_down" numeric(10, 2) NOT NULL,
	"min_instances" integer DEFAULT 1,
	"max_instances" integer DEFAULT 4,
	"gpu_type" text NOT NULL,
	"provider" text DEFAULT 'runpod',
	"enabled" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "gpu_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"gpu_type" text NOT NULL,
	"services" text[] DEFAULT '{}',
	"status" text DEFAULT 'offline',
	"gpu_utilization" numeric(5, 2),
	"is_default" boolean DEFAULT false,
	"last_health_check" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "hetzner_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hetzner_id" bigint,
	"name" text NOT NULL,
	"server_type" text NOT NULL,
	"location" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'provisioning',
	"ip_public" text,
	"ip_private" text,
	"vcpus" integer,
	"ram_gb" integer,
	"calls_handled" integer DEFAULT 0,
	"cpu_percent" numeric(5, 2),
	"mem_percent" numeric(5, 2),
	"uptime_seconds" bigint DEFAULT 0,
	"last_health_check" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "hetzner_servers_hetzner_id_unique" UNIQUE("hetzner_id")
);
--> statement-breakpoint
CREATE TABLE "ivr_menu_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ivr_menu_id" uuid NOT NULL,
	"dtmf_key" text NOT NULL,
	"action_type" text NOT NULL,
	"target_id" uuid,
	"target_number" text,
	"audio_id" uuid,
	"label" text,
	CONSTRAINT "uq_ivr_dtmf" UNIQUE("ivr_menu_id","dtmf_key")
);
--> statement-breakpoint
CREATE TABLE "ivr_menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"welcome_audio_id" uuid,
	"timeout_seconds" integer DEFAULT 5,
	"max_retries" integer DEFAULT 3,
	"invalid_audio_id" uuid,
	"timeout_audio_id" uuid,
	"timeout_action" text DEFAULT 'hangup',
	"timeout_target_id" uuid,
	"after_hours_enabled" boolean DEFAULT false,
	"after_hours_profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kb_source_id" uuid NOT NULL,
	"voicebot_config_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"token_count" integer,
	"chunk_index" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "kb_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"voicebot_config_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"minio_key" text,
	"question" text,
	"answer" text,
	"status" text DEFAULT 'pending',
	"chunk_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "lead_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text DEFAULT 'manual',
	"lead_count" integer DEFAULT 0,
	"dialed_count" integer DEFAULT 0,
	"status" text DEFAULT 'active',
	"dial_mode" text,
	"max_attempts" integer DEFAULT 3,
	"retry_delay_minutes" integer DEFAULT 60,
	"priority" integer DEFAULT 5,
	"timezone" text,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_list_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"alt_phone" text,
	"first_name" text,
	"last_name" text,
	"email" text,
	"company" text,
	"timezone" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"tags" text[] DEFAULT '{}',
	"notes" text,
	"source" text DEFAULT 'manual',
	"priority" integer DEFAULT 5,
	"dnc" boolean DEFAULT false,
	"dnc_reason" text,
	"attempts" integer DEFAULT 0,
	"max_attempts" integer DEFAULT 3,
	"last_attempt_at" timestamp with time zone,
	"last_disposition" text,
	"next_attempt_at" timestamp with time zone,
	"assigned_agent_id" uuid,
	"status" text DEFAULT 'pending',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "npa_nxx" (
	"npa" text NOT NULL,
	"nxx" text NOT NULL,
	"state" text,
	"city" text,
	"county" text,
	"timezone" text,
	"rate_center" text,
	"carrier" text,
	"line_type" text,
	CONSTRAINT "npa_nxx_npa_nxx_pk" PRIMARY KEY("npa","nxx")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"price_monthly" numeric(10, 2) NOT NULL,
	"price_yearly" numeric(10, 2) NOT NULL,
	"max_agents" integer NOT NULL,
	"max_concurrent_calls" integer NOT NULL,
	"max_dids" integer NOT NULL,
	"rate_group_id" uuid,
	"included_credit" numeric(10, 2) DEFAULT '0',
	"features" jsonb DEFAULT '[]'::jsonb,
	"popular" boolean DEFAULT false,
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "plans_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "platform_did_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false,
	"visible_to_all" boolean DEFAULT true,
	"assigned_tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "platform_dids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"provider" text NOT NULL,
	"city" text,
	"state" text,
	"country" text DEFAULT 'US',
	"did_type" text DEFAULT 'local',
	"monthly_cost" numeric(8, 4) DEFAULT '0',
	"status" text DEFAULT 'available',
	"tenant_id" uuid,
	"group_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "platform_dids_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	"strategy" text DEFAULT 'longest_idle',
	"max_wait_seconds" integer DEFAULT 300,
	"announce_position" boolean DEFAULT true,
	"announce_interval_seconds" integer DEFAULT 30,
	"max_queue_size" integer DEFAULT 50,
	"music_on_hold_id" uuid,
	"timeout_destination" text,
	"after_hours_enabled" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rate_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate_group_id" uuid NOT NULL,
	"country" text NOT NULL,
	"country_code" text NOT NULL,
	"direction" text NOT NULL,
	"rate_per_minute" numeric(10, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_rate_card" UNIQUE("rate_group_id","country_code","direction")
);
--> statement-breakpoint
CREATE TABLE "rate_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"inbound_carrier_id" uuid,
	"outbound_carrier_id" uuid,
	"currency" text DEFAULT 'USD',
	"inbound_billing_increment" text DEFAULT '1/1',
	"outbound_billing_increment" text DEFAULT '6/6',
	"feature_billing_increment" text DEFAULT '6/6',
	"recording_rate" numeric(8, 6) DEFAULT '0.002',
	"voicebot_rate" numeric(8, 6) DEFAULT '0.015',
	"byoc_rate" numeric(8, 6) DEFAULT '0.008',
	"storage_rate" numeric(8, 6) DEFAULT '0.10',
	"effective_date" date DEFAULT now() NOT NULL,
	"status" text DEFAULT 'draft',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "scaling_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scaling_rule_id" uuid,
	"action" text NOT NULL,
	"service_type" text NOT NULL,
	"from_instances" integer NOT NULL,
	"to_instances" integer NOT NULL,
	"trigger_metric" text,
	"trigger_value" numeric(12, 4),
	"server_type" text,
	"location" text,
	"duration_ms" integer,
	"status" text DEFAULT 'pending',
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scaling_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"service_type" text NOT NULL,
	"server_type" text,
	"location" text,
	"metric" text NOT NULL,
	"threshold_up" numeric(10, 2) NOT NULL,
	"threshold_down" numeric(10, 2) NOT NULL,
	"min_instances" integer DEFAULT 1,
	"max_instances" integer DEFAULT 10,
	"cooldown_seconds" integer DEFAULT 300,
	"calls_per_instance" integer DEFAULT 0,
	"enabled" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "schedule_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'upcoming',
	"title" text NOT NULL,
	"description" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"lead_id" uuid,
	"lead_name" text,
	"lead_phone" text,
	"priority" text DEFAULT 'medium',
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"ticket_number" text NOT NULL,
	"subject" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open',
	"priority" text DEFAULT 'medium',
	"category" text,
	"created_by" uuid,
	"assigned_to" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "support_tickets_ticket_number_unique" UNIQUE("ticket_number")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"supervisor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"plan_id" uuid,
	"max_agents" integer DEFAULT 10,
	"max_concurrent_calls" integer DEFAULT 20,
	"max_dids" integer DEFAULT 5,
	"logo_url" text,
	"credit_limit" numeric(12, 4) DEFAULT '0',
	"timezone" text DEFAULT 'UTC',
	"domain" text,
	"billing_email" text,
	"customer_type" text,
	"industry" text,
	"phone" text,
	"address" text,
	"city" text,
	"state" text,
	"country" text DEFAULT 'US',
	"features" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"content" text NOT NULL,
	"is_internal" boolean DEFAULT false,
	"attachment_url" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(12, 4) NOT NULL,
	"balance_after" numeric(12, 4) NOT NULL,
	"description" text,
	"reference" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"role" text NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'offline',
	"status_changed_at" timestamp with time zone,
	"team_id" uuid,
	"sip_username" text,
	"sip_password_hash" text,
	"sip_domain" text,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "voicebot_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ollama_model" text DEFAULT 'llama3',
	"engine_stt" text DEFAULT 'whisper',
	"engine_tts" text DEFAULT 'piper',
	"tts_voice" text DEFAULT 'en-US-male',
	"system_prompt" text,
	"max_turns" integer DEFAULT 10,
	"tone" text DEFAULT 'professional',
	"language" text DEFAULT 'en',
	"temperature" numeric(3, 2) DEFAULT '0.7',
	"guardrails" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'untrained',
	"last_trained_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "voicebot_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"call_id" uuid,
	"voicebot_config_id" uuid NOT NULL,
	"turns" jsonb DEFAULT '[]'::jsonb,
	"outcome" text,
	"rating" integer,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "voicebot_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"voicebot_config_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bot_message" text NOT NULL,
	"expected_responses" text[] DEFAULT '{}',
	"next_flow_id" uuid,
	"step_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "voicebot_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"voicebot_config_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"training_phrases" text[] DEFAULT '{}',
	"action" text NOT NULL,
	"response_template" text,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"balance" numeric(12, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD',
	"low_balance_threshold" numeric(12, 4) DEFAULT '10',
	"auto_topup_enabled" boolean DEFAULT false,
	"auto_topup_amount" numeric(12, 4) DEFAULT '100',
	"auto_topup_threshold" numeric(12, 4) DEFAULT '5',
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "wallets_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] DEFAULT '{}',
	"active" boolean DEFAULT true,
	"failure_count" integer DEFAULT 0,
	"last_delivery_at" timestamp with time zone,
	"last_delivery_status" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_files" ADD CONSTRAINT "audio_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "byoc_carriers" ADD CONSTRAINT "byoc_carriers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_integrations" ADD CONSTRAINT "crm_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "did_groups" ADD CONSTRAINT "did_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dids" ADD CONSTRAINT "dids_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dids" ADD CONSTRAINT "dids_platform_did_id_platform_dids_id_fk" FOREIGN KEY ("platform_did_id") REFERENCES "public"."platform_dids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispositions" ADD CONSTRAINT "dispositions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dnc_entries" ADD CONSTRAINT "dnc_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dnc_entries" ADD CONSTRAINT "dnc_entries_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_todos" ADD CONSTRAINT "follow_up_todos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_todos" ADD CONSTRAINT "follow_up_todos_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_alerts" ADD CONSTRAINT "fraud_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_alerts" ADD CONSTRAINT "fraud_alerts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_alerts" ADD CONSTRAINT "fraud_alerts_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_alerts" ADD CONSTRAINT "fraud_alerts_fraud_keyword_id_fraud_keywords_id_fk" FOREIGN KEY ("fraud_keyword_id") REFERENCES "public"."fraud_keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_alerts" ADD CONSTRAINT "fraud_alerts_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_keywords" ADD CONSTRAINT "fraud_keywords_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ivr_menu_actions" ADD CONSTRAINT "ivr_menu_actions_ivr_menu_id_ivr_menus_id_fk" FOREIGN KEY ("ivr_menu_id") REFERENCES "public"."ivr_menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ivr_menus" ADD CONSTRAINT "ivr_menus_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_kb_source_id_kb_sources_id_fk" FOREIGN KEY ("kb_source_id") REFERENCES "public"."kb_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_voicebot_config_id_voicebot_configs_id_fk" FOREIGN KEY ("voicebot_config_id") REFERENCES "public"."voicebot_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_lists" ADD CONSTRAINT "lead_lists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_lists" ADD CONSTRAINT "lead_lists_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_lead_list_id_lead_lists_id_fk" FOREIGN KEY ("lead_list_id") REFERENCES "public"."lead_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_did_groups" ADD CONSTRAINT "platform_did_groups_assigned_tenant_id_tenants_id_fk" FOREIGN KEY ("assigned_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_dids" ADD CONSTRAINT "platform_dids_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_rate_group_id_rate_groups_id_fk" FOREIGN KEY ("rate_group_id") REFERENCES "public"."rate_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_groups" ADD CONSTRAINT "rate_groups_inbound_carrier_id_carriers_id_fk" FOREIGN KEY ("inbound_carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_groups" ADD CONSTRAINT "rate_groups_outbound_carrier_id_carriers_id_fk" FOREIGN KEY ("outbound_carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_events" ADD CONSTRAINT "schedule_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_events" ADD CONSTRAINT "schedule_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_supervisor_id_users_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicebot_configs" ADD CONSTRAINT "voicebot_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicebot_conversations" ADD CONSTRAINT "voicebot_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicebot_conversations" ADD CONSTRAINT "voicebot_conversations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicebot_flows" ADD CONSTRAINT "voicebot_flows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicebot_flows" ADD CONSTRAINT "voicebot_flows_voicebot_config_id_voicebot_configs_id_fk" FOREIGN KEY ("voicebot_config_id") REFERENCES "public"."voicebot_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicebot_intents" ADD CONSTRAINT "voicebot_intents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicebot_intents" ADD CONSTRAINT "voicebot_intents_voicebot_config_id_voicebot_configs_id_fk" FOREIGN KEY ("voicebot_config_id") REFERENCES "public"."voicebot_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_tenant" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_calls_tenant" ON "calls" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_calls_agent" ON "calls" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_calls_campaign" ON "calls" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_calls_uuid" ON "calls" USING btree ("freeswitch_uuid");--> statement-breakpoint
CREATE INDEX "idx_campaigns_tenant" ON "campaigns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_channel" ON "chat_messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_dids_tenant" ON "dids" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_fraud_alerts" ON "fraud_alerts" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_voicebot" ON "kb_chunks" USING btree ("voicebot_config_id");--> statement-breakpoint
CREATE INDEX "idx_leads_tenant_list" ON "leads" USING btree ("tenant_id","lead_list_id");--> statement-breakpoint
CREATE INDEX "idx_leads_phone" ON "leads" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "idx_leads_status" ON "leads" USING btree ("tenant_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_schedule_user" ON "schedule_events" USING btree ("user_id","start_time");--> statement-breakpoint
CREATE INDEX "idx_transactions_tenant" ON "transactions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_users_tenant" ON "users" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");