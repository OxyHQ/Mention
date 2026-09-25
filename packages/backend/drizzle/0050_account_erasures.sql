CREATE TABLE "account_erasures" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"retained" boolean DEFAULT false NOT NULL,
	"username" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"counts" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_erasures_event_id_key" UNIQUE("event_id"),
	CONSTRAINT "account_erasures_source_check" CHECK ("account_erasures"."source" in ('webhook', 'reconciliation', 'operator')),
	CONSTRAINT "account_erasures_status_check" CHECK ("account_erasures"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "account_erasures_attempts_check" CHECK ("account_erasures"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oxy_account_event_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_erasures_oxy_user_id_idx" ON "account_erasures" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "account_erasures_status_idx" ON "account_erasures" USING btree ("status");