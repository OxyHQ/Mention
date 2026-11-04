-- oxy:deploy-phase=pre
-- The Bluesky Jetstream consumer's durable resume position. A new, empty table:
-- no lock on any existing one.
CREATE TABLE "jetstream_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
