-- oxy:deploy-phase=pre
-- Posts that federated communities publish (ActivityPub `Group`, FEP-1b12).
--
-- `community_oxy_user_id` is the Oxy account of the community a post was written
-- in (a Lemmy/PieFed/Mbin community, read from the object's `audience`); the
-- post stays authored by its writer. `content_title` and `content_link_url` are
-- the headline and the subject link a `Page` or `Article` carries apart from
-- its body.
--
-- Nullable, no default: metadata-only ALTERs that rewrite no row. Every
-- existing post was written in no community and carries no title or link.
ALTER TABLE "posts" ADD COLUMN "community_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_title" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_link_url" text;
