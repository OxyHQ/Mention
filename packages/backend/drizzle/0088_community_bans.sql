-- oxy:deploy-phase=pre
-- Who a community hosted here banned from posting in it
-- (`db/schema/communities.ts`). A new, empty table: no lock on anything that
-- exists, so it runs inline.
CREATE TABLE "community_bans" (
	"community_oxy_user_id" text NOT NULL,
	"banned_oxy_user_id" text NOT NULL,
	"banned_by_oxy_user_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "community_bans_community_oxy_user_id_banned_oxy_user_id_pk" PRIMARY KEY("community_oxy_user_id","banned_oxy_user_id")
);
--> statement-breakpoint
CREATE INDEX "community_bans_banned_idx" ON "community_bans" USING btree ("banned_oxy_user_id");