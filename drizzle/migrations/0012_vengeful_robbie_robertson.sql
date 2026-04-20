CREATE TABLE "agent_dids" (
	"agent_id" uuid NOT NULL,
	"did_id" uuid NOT NULL,
	CONSTRAINT "agent_dids_agent_id_did_id_pk" PRIMARY KEY("agent_id","did_id")
);
--> statement-breakpoint
ALTER TABLE "agent_dids" ADD CONSTRAINT "agent_dids_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_dids" ADD CONSTRAINT "agent_dids_did_id_dids_id_fk" FOREIGN KEY ("did_id") REFERENCES "public"."dids"("id") ON DELETE no action ON UPDATE no action;