-- oxy:deploy-phase=pre
-- Every transport copy that asserts one upstream post (see `postTransportCopies`
-- in `src/db/schema/postContent.ts`). A new, empty table: no lock on `posts`
-- beyond the foreign key's SHARE ROW EXCLUSIVE, held for the instant the constraint
-- is added.
CREATE TABLE "post_transport_copies" (
	"object_uri" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"actor_uri" text NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_transport_copies" ADD CONSTRAINT "post_transport_copies_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_transport_copies_post_id_idx" ON "post_transport_copies" USING btree ("post_id");