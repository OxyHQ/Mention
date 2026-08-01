ALTER TABLE "posts" ADD COLUMN "is_reply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "metadata_collab_federation_deferred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "metadata_federation_delivered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "posts_roots_chrono_idx" ON "posts" USING btree ("visibility","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."is_reply" = false;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_reply_discriminator_check" CHECK ("posts"."parent_post_id" is null or "posts"."is_reply");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_federated_reply_discriminator_check" CHECK ("posts"."federation_in_reply_to" is null or "posts"."is_reply");