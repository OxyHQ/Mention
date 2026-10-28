-- oxy:deploy-phase=pre
CREATE TABLE "commerce_post_daily_metrics" (
	"post_id" text NOT NULL,
	"day" date NOT NULL,
	"opens" integer DEFAULT 0 NOT NULL,
	"handoffs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "commerce_post_daily_metrics_post_id_day_pk" PRIMARY KEY("post_id","day"),
	CONSTRAINT "commerce_post_metrics_nonnegative" CHECK ("commerce_post_daily_metrics"."opens" >= 0 and "commerce_post_daily_metrics"."handoffs" >= 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_store_daily_metrics" (
	"oxy_account_id" text NOT NULL,
	"day" date NOT NULL,
	"opens" integer DEFAULT 0 NOT NULL,
	"handoffs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "commerce_store_daily_metrics_oxy_account_id_day_pk" PRIMARY KEY("oxy_account_id","day"),
	CONSTRAINT "commerce_store_metrics_nonnegative" CHECK ("commerce_store_daily_metrics"."opens" >= 0 and "commerce_store_daily_metrics"."handoffs" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_post_daily_metrics" ADD CONSTRAINT "commerce_post_daily_metrics_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_store_daily_metrics" ADD CONSTRAINT "commerce_store_daily_metrics_oxy_account_id_account_storefronts_oxy_account_id_fk" FOREIGN KEY ("oxy_account_id") REFERENCES "public"."account_storefronts"("oxy_account_id") ON DELETE cascade ON UPDATE no action;