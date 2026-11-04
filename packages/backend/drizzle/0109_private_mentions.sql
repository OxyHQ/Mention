-- oxy:deploy-phase=pre
-- Private mentions: the `direct` post visibility, the `post_recipients` ACL
-- table and the `private_mention` notification type.
--
-- No running image writes `direct` or `private_mention`, so widening both
-- CHECKs is safe before the rollout. They are re-added NOT VALID (no scan under
-- the ACCESS EXCLUSIVE lock) and validated by 0110 on its own. The new table is
-- empty, so its foreign key and index cost nothing.
CREATE TABLE "post_recipients" (
	"post_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	CONSTRAINT "post_recipients_pkey" PRIMARY KEY("post_id","oxy_user_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "posts" DROP CONSTRAINT "posts_visibility_check";--> statement-breakpoint
ALTER TABLE "post_recipients" ADD CONSTRAINT "post_recipients_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_recipients_oxy_user_id_idx" ON "post_recipients" USING btree ("oxy_user_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'private_mention', 'follow', 'boost', 'quote', 'welcome', 'post', 'poke', 'collab_invite', 'collab_accepted', 'collab_declined', 'event_updated', 'event_cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_visibility_check" CHECK ("posts"."visibility" in ('public', 'followers_only', 'private', 'direct')) NOT VALID;
