CREATE TABLE "post_equivalence_clusters" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'crosspost' NOT NULL,
	"confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "post_equivalence_clusters_kind_check" CHECK ("post_equivalence_clusters"."kind" in ('crosspost')),
	CONSTRAINT "post_equivalence_clusters_confidence_check" CHECK ("post_equivalence_clusters"."confidence" in ('declared', 'shared-media-id', 'canonical-link', 'fingerprint'))
);
--> statement-breakpoint
CREATE TABLE "post_equivalence_members" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"post_id" text NOT NULL,
	"network_domain" text NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "post_equivalence_members_post_id_key" UNIQUE("post_id")
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "crosspost_collapsed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "post_equivalence_members" ADD CONSTRAINT "post_equivalence_members_cluster_id_post_equivalence_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."post_equivalence_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_equivalence_members" ADD CONSTRAINT "post_equivalence_members_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_equivalence_members_cluster_id_idx" ON "post_equivalence_members" USING btree ("cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_equivalence_members_preferred_key" ON "post_equivalence_members" USING btree ("cluster_id") WHERE "post_equivalence_members"."preferred";--> statement-breakpoint
CREATE INDEX "posts_crosspost_collapsed_idx" ON "posts" USING btree ("crosspost_collapsed") WHERE "posts"."crosspost_collapsed";