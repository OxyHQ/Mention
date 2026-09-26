-- Bookmark folders become rows of their own (OxyHQ/Mention#1124).
--
-- A folder used to exist only as a value on `bookmarks.folder`, so an EMPTY
-- folder could not exist, and the one the Saved screen let a viewer create was
-- lost on reload. `bookmark_folders` now holds every folder, the folder list
-- reads only it, and a composite foreign key makes every filed bookmark name a
-- folder that exists.
--
-- Three steps, in the only order that works:
--  1. create the table;
--  2. bring the existing folder values within the new table's CHECK (trimmed,
--     1..100 characters) and give each (owner, folder) pair a row — ids are
--     uuid v7 stamped with the folder's first bookmark, the shape
--     `generatedId()` mints, since Postgres 17 has no `uuidv7()`;
--  3. add the foreign key, which every existing bookmark now satisfies.
CREATE TABLE "bookmark_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "bookmark_folders_user_id_name_key" UNIQUE("user_id","name"),
	CONSTRAINT "bookmark_folders_name_check" CHECK ("bookmark_folders"."name" = btrim("bookmark_folders"."name") and length("bookmark_folders"."name") between 1 and 100)
);
--> statement-breakpoint
-- Values written before the service trimmed and bounded them. A blank one was
-- always "unfiled", and becomes the NULL that means exactly that.
UPDATE "bookmarks"
SET "folder" = nullif(btrim(left(btrim("folder"), 100)), '')
WHERE "folder" IS NOT NULL
	AND "folder" IS DISTINCT FROM nullif(btrim(left(btrim("folder"), 100)), '');
--> statement-breakpoint
INSERT INTO "bookmark_folders" ("id", "user_id", "name", "created_at", "updated_at")
SELECT
	substr(f.ts, 1, 8) || '-' || substr(f.ts, 9, 4) || '-7' || substr(f.rnd, 1, 3) || '-'
		|| substr('89ab', 1 + floor(random() * 4)::int, 1) || substr(f.rnd, 4, 3) || '-'
		|| substr(f.rnd, 7, 12),
	f.user_id,
	f.folder,
	f.first_at,
	f.first_at
FROM (
	SELECT
		b.user_id,
		b.folder,
		date_trunc('milliseconds', min(b.created_at)) AS first_at,
		lpad(to_hex(floor(extract(epoch FROM min(b.created_at)) * 1000)::bigint), 12, '0') AS ts,
		md5(random()::text || clock_timestamp()::text || b.user_id || b.folder) AS rnd
	FROM "bookmarks" b
	WHERE b.folder IS NOT NULL
	GROUP BY b.user_id, b.folder
) f;
--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_folder_fkey" FOREIGN KEY ("user_id","folder") REFERENCES "public"."bookmark_folders"("user_id","name") ON DELETE no action ON UPDATE no action;
