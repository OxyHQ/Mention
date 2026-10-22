-- oxy:deploy-phase=pre
-- An account's likes are private to it unless it opts in to showing them.
--
-- WHY: the profile's Likes tab and the "who liked this post" lists exposed what
-- every account had liked. `false` keeps the likes visible to their owner only.
--
-- Adding a NOT NULL column with a constant default is safe during a rolling
-- deploy: the previous release neither reads nor writes it.
ALTER TABLE "user_settings" ADD COLUMN "privacy_show_likes" boolean DEFAULT false NOT NULL;
