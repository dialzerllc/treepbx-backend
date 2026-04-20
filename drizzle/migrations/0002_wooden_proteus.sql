CREATE TABLE "stir_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"certificate_authority" text NOT NULL,
	"sp_code" text,
	"cert_pem" text NOT NULL,
	"private_key_hash" text,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"auto_renew" boolean DEFAULT false,
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "stir_did_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"did_id" uuid NOT NULL,
	"certificate_id" uuid NOT NULL,
	"attestation" text DEFAULT 'A' NOT NULL,
	"verified" boolean DEFAULT false,
	"last_signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "stir_certificates" ADD CONSTRAINT "stir_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stir_did_attestations" ADD CONSTRAINT "stir_did_attestations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stir_did_attestations" ADD CONSTRAINT "stir_did_attestations_did_id_dids_id_fk" FOREIGN KEY ("did_id") REFERENCES "public"."dids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stir_did_attestations" ADD CONSTRAINT "stir_did_attestations_certificate_id_stir_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."stir_certificates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_stir_attestation_tenant" ON "stir_did_attestations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_stir_attestation_did" ON "stir_did_attestations" USING btree ("did_id");