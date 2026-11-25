-- oxy:deploy-phase=pre
-- notifications is hot, so alone in its file: its type CHECK learns 'repost' beside 'boost' (NOT VALID, validated in 0139).
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'private_mention', 'follow', 'boost', 'repost', 'quote', 'welcome', 'post', 'poke', 'collab_invite', 'collab_accepted', 'collab_declined', 'event_updated', 'event_cancelled')) NOT VALID;

