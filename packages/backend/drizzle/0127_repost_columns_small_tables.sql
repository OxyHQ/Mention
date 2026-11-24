-- oxy:deploy-phase=pre
-- EXPAND phase of the boost -> repost rename for the smaller tables (docs/repost-rename.md).
-- Every column is a metadata-only add (nullable, or NOT NULL with a constant default).
-- Each table gets a trigger that keeps the old and the new column equal whichever name
-- a writer used, so pods on the old and the new code agree while a deploy rolls: the new
-- column wins when both changed. Defaults-true flags combine with AND on insert, because
-- the new column defaults to true and must not hide a false written under the old name.
ALTER TABLE "blocked_domain_purge_runs" ADD COLUMN "removed_reposts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "blocked_domain_purges" ADD COLUMN "measured_reposts" integer;--> statement-breakpoint
ALTER TABLE "custom_feeds" ADD COLUMN "include_reposts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "author_post_counts" ADD COLUMN "reposts_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_behavior_authors" ADD COLUMN "reposts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE FUNCTION "blocked_domain_purge_runs_sync_repost_columns"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.removed_reposts := GREATEST(NEW.removed_reposts, NEW.removed_boosts);
    NEW.removed_boosts := NEW.removed_reposts;
    RETURN NEW;
  END IF;

  IF NEW.removed_reposts IS DISTINCT FROM OLD.removed_reposts THEN
    NEW.removed_boosts := NEW.removed_reposts;
  ELSIF NEW.removed_boosts IS DISTINCT FROM OLD.removed_boosts THEN
    NEW.removed_reposts := NEW.removed_boosts;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "blocked_domain_purge_runs_sync_repost_columns" BEFORE INSERT OR UPDATE OF "removed_boosts", "removed_reposts"
ON "blocked_domain_purge_runs" FOR EACH ROW EXECUTE FUNCTION "blocked_domain_purge_runs_sync_repost_columns"();--> statement-breakpoint
CREATE FUNCTION "blocked_domain_purges_sync_repost_columns"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.measured_reposts := COALESCE(NEW.measured_reposts, NEW.measured_boosts);
    NEW.measured_boosts := NEW.measured_reposts;
    RETURN NEW;
  END IF;

  IF NEW.measured_reposts IS DISTINCT FROM OLD.measured_reposts THEN
    NEW.measured_boosts := NEW.measured_reposts;
  ELSIF NEW.measured_boosts IS DISTINCT FROM OLD.measured_boosts THEN
    NEW.measured_reposts := NEW.measured_boosts;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "blocked_domain_purges_sync_repost_columns" BEFORE INSERT OR UPDATE OF "measured_boosts", "measured_reposts"
ON "blocked_domain_purges" FOR EACH ROW EXECUTE FUNCTION "blocked_domain_purges_sync_repost_columns"();--> statement-breakpoint
CREATE FUNCTION "custom_feeds_sync_repost_columns"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.include_reposts := NEW.include_reposts AND NEW.include_boosts;
    NEW.include_boosts := NEW.include_reposts;
    RETURN NEW;
  END IF;

  IF NEW.include_reposts IS DISTINCT FROM OLD.include_reposts THEN
    NEW.include_boosts := NEW.include_reposts;
  ELSIF NEW.include_boosts IS DISTINCT FROM OLD.include_boosts THEN
    NEW.include_reposts := NEW.include_boosts;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "custom_feeds_sync_repost_columns" BEFORE INSERT OR UPDATE OF "include_boosts", "include_reposts"
ON "custom_feeds" FOR EACH ROW EXECUTE FUNCTION "custom_feeds_sync_repost_columns"();--> statement-breakpoint
CREATE FUNCTION "author_post_counts_sync_repost_columns"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.reposts_count := GREATEST(NEW.reposts_count, NEW.boosts_count);
    NEW.boosts_count := NEW.reposts_count;
    RETURN NEW;
  END IF;

  IF NEW.reposts_count IS DISTINCT FROM OLD.reposts_count THEN
    NEW.boosts_count := NEW.reposts_count;
  ELSIF NEW.boosts_count IS DISTINCT FROM OLD.boosts_count THEN
    NEW.reposts_count := NEW.boosts_count;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "author_post_counts_sync_repost_columns" BEFORE INSERT OR UPDATE OF "boosts_count", "reposts_count"
ON "author_post_counts" FOR EACH ROW EXECUTE FUNCTION "author_post_counts_sync_repost_columns"();--> statement-breakpoint
CREATE FUNCTION "user_behavior_authors_sync_repost_columns"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.reposts := GREATEST(NEW.reposts, NEW.boosts);
    NEW.boosts := NEW.reposts;
    RETURN NEW;
  END IF;

  IF NEW.reposts IS DISTINCT FROM OLD.reposts THEN
    NEW.boosts := NEW.reposts;
  ELSIF NEW.boosts IS DISTINCT FROM OLD.boosts THEN
    NEW.reposts := NEW.boosts;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "user_behavior_authors_sync_repost_columns" BEFORE INSERT OR UPDATE OF "boosts", "reposts"
ON "user_behavior_authors" FOR EACH ROW EXECUTE FUNCTION "user_behavior_authors_sync_repost_columns"();--> statement-breakpoint
-- The tables below hold at most a few thousand rows, so their existing rows are copied here;
-- author_post_counts (500k rows) is copied by backfillRepostColumns.
UPDATE "blocked_domain_purge_runs" SET removed_reposts = removed_boosts WHERE removed_reposts <> removed_boosts;--> statement-breakpoint
UPDATE "blocked_domain_purges" SET measured_reposts = measured_boosts WHERE measured_reposts IS DISTINCT FROM measured_boosts;--> statement-breakpoint
UPDATE "custom_feeds" SET include_reposts = include_boosts WHERE include_reposts <> include_boosts;--> statement-breakpoint
UPDATE "user_behavior_authors" SET reposts = boosts WHERE reposts <> boosts;
