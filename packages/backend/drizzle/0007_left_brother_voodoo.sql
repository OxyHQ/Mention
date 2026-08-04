CREATE TABLE "mcp_auth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"client_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_label" text NOT NULL,
	"scopes" text[] NOT NULL,
	"bundle_id" text,
	"is_bundle_primary" boolean DEFAULT false NOT NULL,
	"active_oxy_user_id" text,
	"refresh_token_hash" text NOT NULL,
	"jti" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_registered_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_auth_codes_code_key" ON "mcp_auth_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "mcp_auth_codes_expires_at_idx" ON "mcp_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_refresh_token_hash_key" ON "mcp_connections" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_bundle_id_oxy_user_id_key" ON "mcp_connections" USING btree ("bundle_id","oxy_user_id") WHERE "mcp_connections"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "mcp_connections_oxy_user_id_idx" ON "mcp_connections" USING btree ("oxy_user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "mcp_connections_bundle_id_idx" ON "mcp_connections" USING btree ("bundle_id","revoked_at");--> statement-breakpoint
CREATE INDEX "mcp_connections_jti_idx" ON "mcp_connections" USING btree ("jti");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_registered_clients_client_id_key" ON "mcp_registered_clients" USING btree ("client_id");