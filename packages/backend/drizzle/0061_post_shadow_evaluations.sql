CREATE TABLE "post_evaluation_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"topic" text NOT NULL,
	"probability" double precision NOT NULL,
	CONSTRAINT "post_evaluation_topics_evaluation_topic_key" UNIQUE("evaluation_id","topic"),
	CONSTRAINT "post_evaluation_topics_probability_check" CHECK ("post_evaluation_topics"."probability" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "post_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"model" text NOT NULL,
	"policy_ref" text NOT NULL,
	"policy_version" integer NOT NULL,
	"evaluation_version" text NOT NULL,
	"state" text NOT NULL,
	"abstention" text,
	"follow_state" text DEFAULT 'unknown' NOT NULL,
	"languages" text[],
	"spam" double precision,
	"repetition" double precision,
	"feed_value" double precision,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "post_evaluations_revision_release_key" UNIQUE("post_id","fingerprint","model","policy_ref","policy_version","evaluation_version"),
	CONSTRAINT "post_evaluations_state_check" CHECK ("post_evaluations"."state" in ('claimed', 'completed', 'abstained', 'cancelled', 'cost_uncertain')),
	CONSTRAINT "post_evaluations_follow_check" CHECK ("post_evaluations"."follow_state" in ('accepted', 'not_followed', 'unknown')),
	CONSTRAINT "post_evaluations_abstention_check" CHECK ("post_evaluations"."abstention" in ('no_primary_text', 'unknown_language', 'unsupported_language')),
	CONSTRAINT "post_evaluations_policy_version_check" CHECK ("post_evaluations"."policy_version" > 0),
	CONSTRAINT "post_evaluations_scores_check" CHECK ("post_evaluations"."spam" between 0 and 1 and "post_evaluations"."repetition" between 0 and 1 and "post_evaluations"."feed_value" between 0 and 1),
	CONSTRAINT "post_evaluations_result_check" CHECK ((
    "post_evaluations"."state" = 'completed' and "post_evaluations"."spam" is not null and "post_evaluations"."repetition" is not null
    and "post_evaluations"."feed_value" is not null and "post_evaluations"."languages" is not null
    and "post_evaluations"."abstention" is null and "post_evaluations"."finished_at" is not null
  ) or (
    "post_evaluations"."state" <> 'completed' and "post_evaluations"."spam" is null and "post_evaluations"."repetition" is null
    and "post_evaluations"."feed_value" is null and "post_evaluations"."languages" is null
    and (("post_evaluations"."state" = 'abstained' and "post_evaluations"."abstention" is not null)
      or ("post_evaluations"."state" <> 'abstained' and "post_evaluations"."abstention" is null))
  ))
);
--> statement-breakpoint
ALTER TABLE "post_evaluation_topics" ADD CONSTRAINT "post_evaluation_topics_evaluation_id_post_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."post_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_evaluations" ADD CONSTRAINT "post_evaluations_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_evaluations_post_idx" ON "post_evaluations" USING btree ("post_id");