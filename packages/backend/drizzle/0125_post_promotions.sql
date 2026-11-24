-- oxy:deploy-phase=pre
-- Paid distribution of a post: the purchase (post_promotions) and its impression
-- ledger (post_promotion_impressions). New tables only, so no hot-table ALTER:
-- the one lock on `posts` is the FOREIGN KEY from the (empty) promotions table,
-- taken for as long as it takes to add it. Nothing reads these tables until the
-- feature switch (MtnConfig.promotion.enabled) is turned on.
CREATE TABLE "post_promotion_impressions" (
	"promotion_id" text NOT NULL,
	"viewer_oxy_user_id" text NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "post_promotion_impressions_pk" PRIMARY KEY("promotion_id","viewer_oxy_user_id","day")
);
--> statement-breakpoint
CREATE TABLE "post_promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"author_oxy_user_id" text NOT NULL,
	"tier" text NOT NULL,
	"purchased_impressions" integer NOT NULL,
	"delivered_impressions" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"payment_ref" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_promotions_status_check" CHECK ("post_promotions"."status" in ('pending_payment', 'active', 'paused', 'completed', 'canceled', 'refunded')),
	CONSTRAINT "post_promotions_purchased_check" CHECK ("post_promotions"."purchased_impressions" > 0),
	CONSTRAINT "post_promotions_delivered_check" CHECK ("post_promotions"."delivered_impressions" >= 0),
	CONSTRAINT "post_promotions_window_check" CHECK ("post_promotions"."ends_at" is null or "post_promotions"."ends_at" > "post_promotions"."starts_at"),
	CONSTRAINT "post_promotions_active_paid_check" CHECK ("post_promotions"."status" <> 'active' or ("post_promotions"."starts_at" is not null and "post_promotions"."ends_at" is not null and "post_promotions"."payment_ref" is not null))
);
--> statement-breakpoint
ALTER TABLE "post_promotion_impressions" ADD CONSTRAINT "post_promotion_impressions_promotion_id_post_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."post_promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_promotions" ADD CONSTRAINT "post_promotions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_promotion_impressions_viewer_idx" ON "post_promotion_impressions" USING btree ("viewer_oxy_user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "post_promotions_one_open_per_post_key" ON "post_promotions" USING btree ("post_id") WHERE "post_promotions"."status" in ('pending_payment', 'active', 'paused');--> statement-breakpoint
CREATE INDEX "post_promotions_status_ends_idx" ON "post_promotions" USING btree ("status","ends_at");--> statement-breakpoint
CREATE INDEX "post_promotions_author_idx" ON "post_promotions" USING btree ("author_oxy_user_id","created_at");
