-- oxy:deploy-phase=pre
-- `post_engagement_ranks`: the popular scans' ORDER BY, moved off `posts` so a
-- counter bump on `posts` can be a HOT update.
--
-- WHY: `posts_engagement_rank_idx` (0028, rebuilt by 0129) is an expression
-- index over the four engagement counters. A column covered by ANY index makes
-- an update to it non-HOT, so every like, repost and comment count change wrote
-- a new entry into all 34 indexes on `posts`. Production, 2026-11-28:
-- 470,041 updates of `posts` since the cutover, 9,385 (2%) HOT; the like bump
-- alone ran 292,523 times for 591 s of database time, 2.07M blocks read and
-- 6.97 GB of WAL (23.8 kB per like).
--
-- This file creates nothing on `posts`: a new table, its index, and three
-- functions. The triggers that call them are 0142 (hot-table DDL, alone in its
-- file) and `fillfactor` is 0143. The expression index stays until the readers
-- have moved; dropping it is a later `post` migration.
--
-- What the table holds: exactly the posts with visibility 'public', status
-- 'published' and a NON-ZERO rank, keyed by the same (rank desc, created_at
-- desc, id desc) as the expression index, plus the post's `is_reply` and its
-- languages (`classification_languages || translated_languages`) as trailing
-- index columns, so the roots-only and reader-language lanes reject a candidate
-- inside an index-only scan instead of fetching its `posts` row. Rank-0 posts are left out on purpose:
-- they are 70% of production's public posts and almost every new one, they all
-- tie on rank, and among themselves they are ordered by (created_at desc, id
-- desc), which `post_public_chrono_v1` / `posts_roots_chrono_idx` already serve.
-- So a new post costs this table nothing until something engages with it.
--
-- `post_engagement_rank()` is `engagementRankSql` (`src/db/schema/posts.ts`) in
-- SQL, character for character over the four counters, with the same weights,
-- the same `greatest(0, …)` floor and the same double-precision arithmetic, so
-- it produces the same float8 bit pattern. `postEngagementRanks.test.ts`
-- evaluates the two side by side and fails on the first value they disagree on;
-- a weight retuned in `MtnConfig.ranking.engagement` needs a migration that
-- replaces this function and recomputes the table.
--
-- No foreign key to `posts`, deliberately: a foreign key would take a
-- FOR KEY SHARE lock on the `posts` row for every row inserted here (a heap
-- write and a WAL record each, about 4.1M of them during the backfill) and run a
-- cascade lookup for every deleted post, rank 0 or not. The delete and truncate
-- triggers in 0142 do the same work only where a row exists.
CREATE TABLE "post_engagement_ranks" (
	"post_id" text PRIMARY KEY NOT NULL,
	"engagement_rank" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"is_reply" boolean NOT NULL,
	"languages" text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX "post_engagement_ranks_rank_idx" ON "post_engagement_ranks" USING btree ("engagement_rank" DESC NULLS LAST,"created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST,"is_reply","languages");
--> statement-breakpoint
CREATE FUNCTION "post_engagement_rank"(
  "stats_likes_count" integer,
  "stats_reposts_count" integer,
  "stats_federated_reposts_count" integer,
  "stats_comments_count" integer
) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN ((
    "stats_likes_count" * 1::double precision
    + greatest(0, "stats_reposts_count" - "stats_federated_reposts_count") * 2.5::double precision
    + "stats_federated_reposts_count" * 0.5::double precision
    + "stats_comments_count" * 2::double precision
  )::double precision);
--> statement-breakpoint
-- Writes the post's row from the row the write produced. An UPDATE that keeps
-- the post listed rewrites its row in place, and inserts it only when there is
-- none yet (a post the backfill has not reached): `ON CONFLICT` there because
-- the backfill may be inserting the same post at that moment.
CREATE FUNCTION "post_engagement_ranks_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  new_rank double precision;
  new_languages text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM post_engagement_ranks WHERE post_id = OLD.id;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id THEN
    DELETE FROM post_engagement_ranks WHERE post_id = OLD.id;
  END IF;
  new_rank := post_engagement_rank(
    NEW.stats_likes_count, NEW.stats_reposts_count,
    NEW.stats_federated_reposts_count, NEW.stats_comments_count);
  IF NEW.visibility = 'public' AND NEW.status = 'published' AND new_rank <> 0 THEN
    new_languages := coalesce(NEW.classification_languages, '{}') || coalesce(NEW.translated_languages, '{}');
    UPDATE post_engagement_ranks
      SET engagement_rank = new_rank, created_at = NEW.created_at,
          is_reply = NEW.is_reply, languages = new_languages
      WHERE post_id = NEW.id;
    IF NOT FOUND THEN
      INSERT INTO post_engagement_ranks (post_id, engagement_rank, created_at, is_reply, languages)
        VALUES (NEW.id, new_rank, NEW.created_at, NEW.is_reply, new_languages)
        ON CONFLICT (post_id) DO UPDATE
          SET engagement_rank = EXCLUDED.engagement_rank, created_at = EXCLUDED.created_at,
              is_reply = EXCLUDED.is_reply, languages = EXCLUDED.languages;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    DELETE FROM post_engagement_ranks WHERE post_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "post_engagement_ranks_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE post_engagement_ranks;
  RETURN NULL;
END;
$$;
