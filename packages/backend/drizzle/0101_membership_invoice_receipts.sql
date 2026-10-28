-- oxy:deploy-phase=pre
CREATE TABLE "membership_billing_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"tier_id" text NOT NULL,
	"payer_oxy_user_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"app_id" text NOT NULL,
	"mode" text NOT NULL,
	"environment" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_version" integer NOT NULL,
	"provider_price_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "membership_billing_receipts_source_key" UNIQUE("merchant_id","app_id","mode","environment","invoice_id"),
	CONSTRAINT "membership_billing_receipts_mode_check" CHECK ("membership_billing_receipts"."mode" in ('test', 'live')),
	CONSTRAINT "membership_billing_receipts_environment_check" CHECK ("membership_billing_receipts"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "membership_billing_receipts_state_check" CHECK ("membership_billing_receipts"."state" in ('paid', 'partially_refunded', 'fully_refunded')),
	CONSTRAINT "membership_billing_receipts_period_check" CHECK ("membership_billing_receipts"."period_end" > "membership_billing_receipts"."period_start"),
	CONSTRAINT "membership_billing_receipts_version_check" CHECK ("membership_billing_receipts"."offer_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "membership_billing_receipts" ADD CONSTRAINT "membership_billing_receipts_community_id_membership_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."membership_communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_billing_receipts" ADD CONSTRAINT "membership_billing_receipts_tier_id_community_id_membership_tiers_id_community_id_fk" FOREIGN KEY ("tier_id","community_id") REFERENCES "public"."membership_tiers"("id","community_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_billing_receipts_payer_idx" ON "membership_billing_receipts" USING btree ("payer_oxy_user_id");--> statement-breakpoint
CREATE INDEX "membership_billing_receipts_community_idx" ON "membership_billing_receipts" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "membership_billing_receipts_tier_idx" ON "membership_billing_receipts" USING btree ("tier_id","community_id");