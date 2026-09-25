-- `resolvePostIdFromNoteUrl` (the only way a Threads quote resolves) matches
-- `posts.federation_url` exactly, and nothing indexed it: every call was a
-- parallel sequential scan of the whole table. Measured in production
-- (Performance Insights, 2026-09-25): ~2 s and ~98k shared buffers per call,
-- ~300 calls a day from the inbox path, each holding a pool connection and
-- pushing the working set of every other query out of cache (#1158).
-- Partial, like `posts_federation_actor_uri_idx` (0039): local posts never
-- carry a federation URL.
-- This uses the existing transactional migrator: CONCURRENTLY is unavailable.
-- CREATE INDEX takes SHARE: reads continue, writes wait until the transaction
-- commits. Refuse after 5s acquiring locks or 60s building, rather than create
-- an unbounded write stall. A failure rolls back the index and ledger entry.
-- 0039 built the same shape of index over the same ~1.5M rows inside that
-- budget.
-- Preserve the connection settings for any later migration in this transaction.
SELECT set_config('mention.federation_url_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.federation_url_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX "posts_federation_url_idx" ON "posts" USING btree ("federation_url") WHERE "posts"."federation_url" is not null;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.federation_url_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.federation_url_statement_timeout'), true);
