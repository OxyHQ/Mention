-- oxy:deploy-phase=post
-- The MTN signed-record chain and Mention nodes are gone: the release before this
-- one (#1805) stopped every write and read of these four tables. None has a
-- foreign key in or out, so each drop locks only its own table.
DROP TABLE "mention_node_ingest_witnesses" CASCADE;--> statement-breakpoint
DROP TABLE "mention_repo_heads" CASCADE;--> statement-breakpoint
DROP TABLE "mention_signed_records" CASCADE;--> statement-breakpoint
DROP TABLE "mention_user_nodes" CASCADE;