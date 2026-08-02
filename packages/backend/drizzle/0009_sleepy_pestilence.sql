CREATE TABLE "admin_script_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"script" text NOT NULL,
	"scope" text NOT NULL,
	"cursor" text NOT NULL,
	"scanned" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "admin_script_cursors_scanned_check" CHECK ("admin_script_cursors"."scanned" >= 0)
);
--> statement-breakpoint
CREATE TABLE "repair_fetch_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"script" text NOT NULL,
	"post_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" integer,
	"failed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "repair_fetch_failures_status_check" CHECK ("repair_fetch_failures"."status" is null or ("repair_fetch_failures"."status" >= 100 and "repair_fetch_failures"."status" <= 599))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_script_cursors_script_scope_key" ON "admin_script_cursors" USING btree ("script","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "repair_fetch_failures_script_post_id_key" ON "repair_fetch_failures" USING btree ("script","post_id");--> statement-breakpoint
CREATE INDEX "repair_fetch_failures_script_reason_idx" ON "repair_fetch_failures" USING btree ("script","reason");