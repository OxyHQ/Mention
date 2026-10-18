-- oxy:deploy-phase=pre
-- Additive private UI workspace; no existing table rewrite or lock.
CREATE TABLE "deck_workspaces" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "deck_workspaces_revision_check" CHECK ("deck_workspaces"."revision" > 0),
	CONSTRAINT "deck_workspaces_state_check" CHECK (jsonb_typeof("deck_workspaces"."state") = 'object')
);
