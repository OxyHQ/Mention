-- The backfill's two bookkeeping tables, created HERE and by nothing else.
--
-- Both used to be created at RUNTIME with `create table if not exists`, by
-- `checkpointStore.ts` and `resolutionLogStore.ts`. That put a `CREATE` on the
-- copy's very first statement, which is a privilege the running role may not
-- hold — and a run that dies there has read nothing, resolved nothing, and
-- leaves an operator to work out that the failure was a permission and not the
-- data. The tables now arrive with the schema, and those two modules VERIFY
-- rather than create (`assertBookkeepingTableExists`), so no path creates them
-- late.
--
-- They are deliberately NOT in the drizzle schema barrel. `tablesWithoutAPlan()`
-- refuses to start a copy while any barrel table has no plan feeding it, and
-- these two have no Mongo source by construction — they are bookkeeping ABOUT
-- the copy, not data it carries. Hand-written SQL plus a snapshot identical to
-- 0015 is what keeps `drizzle-kit generate` reporting "No schema changes" while
-- the migrator still applies this file.
--
-- `create table` without `if not exists` is deliberate: a database that already
-- holds a runtime-created copy of either table must fail loudly here rather than
-- silently accept whatever shape it was left in. Drop the stray table and
-- re-run; the ledger makes this file run exactly once.
CREATE TABLE "mention_backfill_checkpoints" (
	"collection" text PRIMARY KEY NOT NULL,
	-- The `_id` a resume continues after, stored as TEXT with its BSON KIND
	-- alongside and never inferred from the value. Both kinds can spell 24 hex
	-- characters, and `{$gt: ObjectId(...)}` against a string `_id` matches
	-- NOTHING in Mongo — silently — so a resumed run would report "0 documents
	-- remaining" and be believed.
	"checkpoint_value" text,
	"checkpoint_kind" text,
	-- Separate from the position because they answer different questions: a
	-- position says "resume here", `completed` says "do not resume at all".
	"completed" boolean DEFAULT false NOT NULL,
	"documents_copied" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_backfill_checkpoints_kind_check" CHECK ("checkpoint_kind" in ('objectId', 'string'))
);
--> statement-breakpoint
CREATE TABLE "mention_backfill_resolution_log" (
	-- A surrogate key: an append-only journal with no natural one, since
	-- `within` is nullable by design and so cannot be part of a primary key.
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	-- Keyed by RUN so a re-run, a resumed run and the cutover are separable
	-- rather than one undifferentiated pile.
	"run_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"collection" text NOT NULL,
	"document_id" text NOT NULL,
	"within" text,
	"detail" text NOT NULL,
	"evidence" jsonb,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The two questions anyone actually asks: everything one run did, and
-- everything ever done to one document.
CREATE INDEX "mention_backfill_resolution_log_run_rule_idx" ON "mention_backfill_resolution_log" ("run_id","rule_id");--> statement-breakpoint
CREATE INDEX "mention_backfill_resolution_log_document_idx" ON "mention_backfill_resolution_log" ("document_id");
