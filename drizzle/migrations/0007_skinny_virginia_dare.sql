ALTER TABLE "rate_cards" DROP CONSTRAINT "uq_rate_card";--> statement-breakpoint
ALTER TABLE "rate_cards" ADD CONSTRAINT "uq_rate_card" UNIQUE("rate_group_id","country","direction");