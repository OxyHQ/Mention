-- Link cards a federated post arrived with (FEP-8967, which Mastodon 4.7 emits).
--
-- The text of the card the author's server rendered for a link in the body, per
-- post, in attachment order. Hydration shows one only while Clarity has no
-- document for the link. Keyed by post rather than URL so one server cannot
-- rewrite the card of a link on everybody else's posts; no image column, so no
-- reader's request is ever sent to a host the author chose.
CREATE TABLE "post_link_previews" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"description" text,
	CONSTRAINT "post_link_previews_post_id_position_key" UNIQUE("post_id","position"),
	CONSTRAINT "post_link_previews_position_check" CHECK ("post_link_previews"."position" >= 0),
	CONSTRAINT "post_link_previews_card_check" CHECK ("post_link_previews"."title" is not null or "post_link_previews"."description" is not null)
);
--> statement-breakpoint
ALTER TABLE "post_link_previews" ADD CONSTRAINT "post_link_previews_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;