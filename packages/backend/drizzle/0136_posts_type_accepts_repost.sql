-- oxy:deploy-phase=pre
-- posts is hot, so alone in its file: its type CHECK learns 'repost' beside 'boost' (NOT VALID, validated in 0139).
ALTER TABLE "posts" DROP CONSTRAINT "posts_type_check";--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_type_check" CHECK ("posts"."type" in ('text', 'image', 'video', 'poll', 'boost', 'repost', 'quote')) NOT VALID;

