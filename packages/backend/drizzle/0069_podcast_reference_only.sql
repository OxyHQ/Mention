-- Compatible with the previous image: keep nullable columns so its SQL still
-- works, but clear copies even when an old instance writes during rollout.
-- The replacement image reads only content_podcast_syra_id. Physical column
-- removal can be a later contract migration after old instances are retired.
CREATE FUNCTION clear_post_podcast_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_podcast_title := NULL;
  NEW.content_podcast_author := NULL;
  NEW.content_podcast_artwork_url := NULL;
  NEW.content_podcast_show_url := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER posts_podcast_reference_only
BEFORE INSERT OR UPDATE OF content_podcast_title, content_podcast_author,
  content_podcast_artwork_url, content_podcast_show_url ON posts
FOR EACH ROW EXECUTE FUNCTION clear_post_podcast_snapshot();
--> statement-breakpoint
UPDATE posts SET content_podcast_title = NULL, content_podcast_author = NULL,
  content_podcast_artwork_url = NULL, content_podcast_show_url = NULL
WHERE content_podcast_title IS NOT NULL OR content_podcast_author IS NOT NULL
   OR content_podcast_artwork_url IS NOT NULL OR content_podcast_show_url IS NOT NULL;
