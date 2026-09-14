-- Each projected source previously scanned all posts twice. A partial B-tree
-- narrows both reads to that immutable actor without indexing local posts.
-- This uses the existing transactional migrator: CONCURRENTLY is unavailable.
-- CREATE INDEX takes SHARE: reads continue, writes wait until the transaction
-- commits. Refuse after 5s acquiring locks or 60s building, rather than create
-- an unbounded write stall. A failure rolls back the index and ledger entry.
-- Preserve the connection settings for any later migration in this transaction.
SELECT set_config('mention.source_projection_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.source_projection_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX "posts_federation_actor_uri_idx" ON "posts" USING btree ("federation_actor_uri") WHERE "posts"."federation_actor_uri" is not null;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.source_projection_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.source_projection_statement_timeout'), true);
