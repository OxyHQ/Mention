-- oxy:deploy-phase=pre
-- The remote follow-graph mirror: three NEW tables, so no lock on any existing
-- one. Nothing reads or writes them before this release.
CREATE TABLE "remote_actor_refs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "remote_actor_refs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uri" text NOT NULL,
	CONSTRAINT "remote_actor_refs_uri_key" UNIQUE("uri")
);
--> statement-breakpoint
CREATE TABLE "remote_follow_edges" (
	"source_id" integer NOT NULL,
	"target_id" integer NOT NULL,
	"record_key" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_follow_edges_pkey" PRIMARY KEY("source_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "remote_graph_crawls" (
	"actor_uri" text PRIMARY KEY NOT NULL,
	"following_state" text,
	"followers_state" text,
	"crawled_at" timestamp with time zone,
	"crawl_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "remote_graph_crawls_following_state_check" CHECK ("remote_graph_crawls"."following_state" is null or "remote_graph_crawls"."following_state" in ('visible', 'hidden')),
	CONSTRAINT "remote_graph_crawls_followers_state_check" CHECK ("remote_graph_crawls"."followers_state" is null or "remote_graph_crawls"."followers_state" in ('visible', 'hidden'))
);
--> statement-breakpoint
ALTER TABLE "remote_follow_edges" ADD CONSTRAINT "remote_follow_edges_source_id_remote_actor_refs_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."remote_actor_refs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_follow_edges" ADD CONSTRAINT "remote_follow_edges_target_id_remote_actor_refs_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."remote_actor_refs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_follow_edges_target_idx" ON "remote_follow_edges" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "remote_follow_edges_last_seen_at_idx" ON "remote_follow_edges" USING btree ("last_seen_at");