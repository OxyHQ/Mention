-- oxy:deploy-phase=pre
-- EXPAND phase of the boost -> repost rename, for the posts table (docs/boost.md).
--
-- Four columns that are new names of existing ones. All four are metadata-only
-- adds on PostgreSQL 11+: nullable, or NOT NULL with a constant default, so
-- nothing is rewritten and the lock is the instant the catalog is changed. The
-- foreign key is NOT VALID, so no scan of posts happens here; 0127 validates it
-- once the backfill has copied the existing rows across.
ALTER TABLE "posts" ADD COLUMN "repost_of" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "stats_reposts_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "stats_federated_reposts_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "metadata_is_reposted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_repost_of_posts_id_fk" FOREIGN KEY ("repost_of") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
-- Keeps each old/new pair equal whichever name a writer used, so a pod running
-- the old code and one running the new code read the same data while a deploy
-- rolls. The rule is the same for every pair: if the NEW column was written, it
-- wins; otherwise if the OLD one was, it wins. On INSERT both default to the
-- empty value, so whichever was set is copied to the other.
CREATE FUNCTION "posts_sync_repost_columns"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.repost_of := COALESCE(NEW.repost_of, NEW.boost_of);
    NEW.boost_of := NEW.repost_of;
    NEW.stats_reposts_count := GREATEST(NEW.stats_reposts_count, NEW.stats_boosts_count);
    NEW.stats_boosts_count := NEW.stats_reposts_count;
    NEW.stats_federated_reposts_count :=
      GREATEST(NEW.stats_federated_reposts_count, NEW.stats_federated_boosts_count);
    NEW.stats_federated_boosts_count := NEW.stats_federated_reposts_count;
    NEW.metadata_is_reposted := NEW.metadata_is_reposted OR NEW.metadata_is_boosted;
    NEW.metadata_is_boosted := NEW.metadata_is_reposted;
    RETURN NEW;
  END IF;

  IF NEW.repost_of IS DISTINCT FROM OLD.repost_of THEN
    NEW.boost_of := NEW.repost_of;
  ELSIF NEW.boost_of IS DISTINCT FROM OLD.boost_of THEN
    NEW.repost_of := NEW.boost_of;
  END IF;

  IF NEW.stats_reposts_count IS DISTINCT FROM OLD.stats_reposts_count THEN
    NEW.stats_boosts_count := NEW.stats_reposts_count;
  ELSIF NEW.stats_boosts_count IS DISTINCT FROM OLD.stats_boosts_count THEN
    NEW.stats_reposts_count := NEW.stats_boosts_count;
  END IF;

  IF NEW.stats_federated_reposts_count IS DISTINCT FROM OLD.stats_federated_reposts_count THEN
    NEW.stats_federated_boosts_count := NEW.stats_federated_reposts_count;
  ELSIF NEW.stats_federated_boosts_count IS DISTINCT FROM OLD.stats_federated_boosts_count THEN
    NEW.stats_federated_reposts_count := NEW.stats_federated_boosts_count;
  END IF;

  IF NEW.metadata_is_reposted IS DISTINCT FROM OLD.metadata_is_reposted THEN
    NEW.metadata_is_boosted := NEW.metadata_is_reposted;
  ELSIF NEW.metadata_is_boosted IS DISTINCT FROM OLD.metadata_is_boosted THEN
    NEW.metadata_is_reposted := NEW.metadata_is_boosted;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
-- UPDATE OF the eight columns only: the engagement counters that move on every
-- like or comment are other columns and never fire this.
CREATE TRIGGER "posts_sync_repost_columns" BEFORE INSERT OR UPDATE OF
  "boost_of", "repost_of",
  "stats_boosts_count", "stats_reposts_count",
  "stats_federated_boosts_count", "stats_federated_reposts_count",
  "metadata_is_boosted", "metadata_is_reposted"
ON "posts" FOR EACH ROW EXECUTE FUNCTION "posts_sync_repost_columns"();
