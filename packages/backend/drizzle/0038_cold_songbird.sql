-- `array_to_string` is STABLE, not IMMUTABLE (Postgres will not say why on this
-- build; the conservative classification most likely covers a locale-dependent
-- separator or element cast in the general case), so it cannot appear directly
-- in an index expression. This wraps it in a thin SQL function this schema
-- controls and can mark IMMUTABLE itself: joining `hashtags` (already-lowercased
-- `text[]`, no per-element formatting) with a fixed ASCII space is deterministic
-- for every input this column ever holds, which is the actual promise IMMUTABLE
-- makes on an index. `routes/hashtags.ts`'s coarse trigram filter calls this same
-- function, so the query and the index agree on the same expression by never
-- restating it.
CREATE OR REPLACE FUNCTION posts_hashtags_search_text(text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT array_to_string($1, ' ')
$$;

CREATE INDEX "posts_hashtags_trgm_gin" ON "posts" USING gin (posts_hashtags_search_text("hashtags") gin_trgm_ops) WHERE "posts"."visibility" = 'public' and coalesce(cardinality("posts"."hashtags"), 0) > 0;
