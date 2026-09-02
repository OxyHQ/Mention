CREATE TABLE "mcp_effect_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"response_status" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mcp_effect_receipts_status_check" CHECK ("mcp_effect_receipts"."status" in ('started', 'succeeded', 'failed', 'indeterminate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_effect_receipts_account_client_key_unique" ON "mcp_effect_receipts" USING btree ("oxy_user_id","client_id","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "mcp_effect_receipts_created_at_idx" ON "mcp_effect_receipts" USING btree ("created_at");