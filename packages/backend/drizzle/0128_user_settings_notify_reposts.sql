-- oxy:deploy-phase=pre
-- EXPAND phase of the boost -> repost rename for user_settings, a hot table, so alone in its
-- file (docs/repost-rename.md). A constant-default NOT NULL add is metadata-only. The trigger
-- keeps the two flags equal whichever name a writer used; both default to true, so on insert
-- they combine with AND and a false written under the old name is not hidden.
ALTER TABLE "user_settings" ADD COLUMN "notify_reposts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE FUNCTION "user_settings_sync_repost_columns"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.notify_reposts := NEW.notify_reposts AND NEW.notify_boosts;
    NEW.notify_boosts := NEW.notify_reposts;
    RETURN NEW;
  END IF;

  IF NEW.notify_reposts IS DISTINCT FROM OLD.notify_reposts THEN
    NEW.notify_boosts := NEW.notify_reposts;
  ELSIF NEW.notify_boosts IS DISTINCT FROM OLD.notify_boosts THEN
    NEW.notify_reposts := NEW.notify_boosts;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "user_settings_sync_repost_columns" BEFORE INSERT OR UPDATE OF "notify_boosts", "notify_reposts"
ON "user_settings" FOR EACH ROW EXECUTE FUNCTION "user_settings_sync_repost_columns"();
