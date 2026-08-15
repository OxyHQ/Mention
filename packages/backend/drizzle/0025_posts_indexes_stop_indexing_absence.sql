DROP INDEX "posts_thread_idx";--> statement-breakpoint
DROP INDEX "posts_classification_region_idx";--> statement-breakpoint
DROP INDEX "posts_geo_gist";--> statement-breakpoint
DROP INDEX "posts_content_geo_gist";--> statement-breakpoint
CREATE INDEX "posts_thread_idx" ON "posts" USING btree ("thread_id","oxy_user_id","parent_post_id","created_at") WHERE "posts"."thread_id" is not null;--> statement-breakpoint
CREATE INDEX "posts_classification_region_idx" ON "posts" USING btree ("classification_region","created_at" DESC NULLS LAST) WHERE "posts"."classification_region" is not null;--> statement-breakpoint
CREATE INDEX "posts_geo_gist" ON "posts" USING gist ("geo") WHERE "posts"."geo" is not null;--> statement-breakpoint
CREATE INDEX "posts_content_geo_gist" ON "posts" USING gist ("content_geo") WHERE "posts"."content_geo" is not null;