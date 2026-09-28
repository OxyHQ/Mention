-- `federated_banner_mirrors`: the durable retry state of mirroring a federated
-- account's banner into Oxy (services/federatedBannerMirror.ts). One NEW, empty
-- table and its partial index — no existing table is touched or locked. Rows are
-- written by actor resolves (the advertised banner URL) and by the one-shot
-- `scripts/queueFederatedBannerMirrors.ts` (recovery), and drained by the
-- periodic `runFederatedBannerMirrors` sweep.
CREATE TABLE "federated_banner_mirrors" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"actor_uri" text NOT NULL,
	"source_url" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_failure" text,
	"mirrored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federated_banner_mirrors_state_check" CHECK ("federated_banner_mirrors"."state" in ('pending', 'mirrored', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "federated_banner_mirrors_due_idx" ON "federated_banner_mirrors" USING btree ("retry_at") WHERE "federated_banner_mirrors"."state" <> 'mirrored';