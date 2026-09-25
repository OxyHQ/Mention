-- The import ledger: one row per post a user brought from another platform
-- through Oxy Move (`routes/imports.ts`, contract in `docs/import.mdx`).
--
-- WHY: an imported post is an ordinary native post, so nothing on `posts` can
-- say it was imported. This table is the dedupe key a re-sent item resolves
-- through (UNIQUE on user + platform + source id), the scope undo deletes
-- (`import_batch_id`), and the provenance hydration renders.
--
-- Safe during a rolling deploy: a NEW table that the previous release neither
-- reads nor writes, and a CASCADE that only fires on deleting a post that has a
-- ledger row — which no previous-release write path can create.
CREATE TABLE "post_imports" (
	"post_id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"platform" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text NOT NULL,
	"content_warning" text,
	"import_batch_id" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_imports_source_key" UNIQUE("oxy_user_id","platform","source_id"),
	CONSTRAINT "post_imports_platform_check" CHECK ("post_imports"."platform" in ('mastodon', 'bluesky', 'threads', 'instagram', 'x', 'facebook', 'medium', 'substack'))
);
--> statement-breakpoint
ALTER TABLE "post_imports" ADD CONSTRAINT "post_imports_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_imports_batch_idx" ON "post_imports" USING btree ("import_batch_id");