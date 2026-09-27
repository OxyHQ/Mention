-- Instagram posts through Meta's Graph API (connectors/instagram/).
--
-- 1. `instagram-graph` becomes a federation protocol: an Instagram account Oxy
--    resolved through the Graph API because no ActivityPub bridge answered for
--    it (`federated_actors.uri` = `instagram-graph:<ig-user-id>`), and the
--    network a local subscription to one is recorded under. Both CHECKs are
--    WIDENED (every existing row satisfies the new list).
-- 2. `federated_actors.instagram_graph_*`: the cooldown + lease + last result of
--    the Graph post sync, separate from the ActivityPub outbox stamps so neither
--    sync can starve the other.
-- 3. `posts.source_post_key` + a partial UNIQUE index: one Instagram post reached
--    both through the Graph API and through the kilogram.makeup bridge is ONE
--    row (`instagram:<shortcode>`), whichever road arrives second.
--
-- The index build reads all of `posts` under the existing transactional
-- migrator (CONCURRENTLY is unavailable): reads continue, writes wait until the
-- transaction commits. Bounded exactly like 0039 — refuse after 5s acquiring
-- locks or 60s building rather than stall writes without limit; a failure rolls
-- back the whole migration and its ledger entry. The connection's prior
-- timeouts are restored for any later migration in the same transaction.
SELECT set_config('mention.instagram_graph_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.instagram_graph_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
ALTER TABLE "federated_actors" DROP CONSTRAINT "federated_actors_protocol_check";--> statement-breakpoint
ALTER TABLE "federated_follows" DROP CONSTRAINT "federated_follows_network_check";--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "instagram_graph_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "instagram_graph_sync_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "instagram_graph_last_result" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "source_post_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_source_post_key_key" ON "posts" USING btree ("source_post_key") WHERE "posts"."source_post_key" is not null;--> statement-breakpoint
ALTER TABLE "federated_actors" ADD CONSTRAINT "federated_actors_instagram_graph_last_result_check" CHECK ("federated_actors"."instagram_graph_last_result" is null or "federated_actors"."instagram_graph_last_result" in ('ok', 'not_business', 'error'));--> statement-breakpoint
ALTER TABLE "federated_actors" ADD CONSTRAINT "federated_actors_protocol_check" CHECK ("federated_actors"."protocol" in ('activitypub', 'atproto', 'instagram-graph'));--> statement-breakpoint
ALTER TABLE "federated_follows" ADD CONSTRAINT "federated_follows_network_check" CHECK ("federated_follows"."network" in ('activitypub', 'atproto', 'instagram-graph'));
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.instagram_graph_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.instagram_graph_statement_timeout'), true);
