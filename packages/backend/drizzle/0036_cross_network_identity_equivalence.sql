CREATE TABLE "federated_identity_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_actor_uri" text NOT NULL,
	"subject" text NOT NULL,
	"target" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federated_identity_claims_actor_target_kind_key" UNIQUE("subject_actor_uri","target","kind"),
	CONSTRAINT "federated_identity_claims_kind_check" CHECK ("federated_identity_claims"."kind" in ('first-party-link', 'also-known-as', 'verified-profile-link'))
);
--> statement-breakpoint
CREATE TABLE "federated_identity_link_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"subject_actor_uri" text NOT NULL,
	"subject" text NOT NULL,
	"target" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federated_identity_link_evidence_claim_key" UNIQUE("link_id","subject_actor_uri","target","kind"),
	CONSTRAINT "federated_identity_link_evidence_kind_check" CHECK ("federated_identity_link_evidence"."kind" in ('first-party-link', 'also-known-as', 'verified-profile-link'))
);
--> statement-breakpoint
CREATE TABLE "federated_identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_a" text NOT NULL,
	"identity_b" text NOT NULL,
	"actor_uri_a" text,
	"actor_uri_b" text,
	"status" text NOT NULL,
	"oxy_user_id" text,
	"reason" text NOT NULL,
	"linked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federated_identity_links_pair_key" UNIQUE("identity_a","identity_b"),
	CONSTRAINT "federated_identity_links_status_check" CHECK ("federated_identity_links"."status" in ('linked', 'pending_reconciliation', 'revoked')),
	CONSTRAINT "federated_identity_links_oxy_user_id_check" CHECK (("federated_identity_links"."status" = 'linked') = ("federated_identity_links"."oxy_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "federated_identity_link_evidence" ADD CONSTRAINT "federated_identity_link_evidence_link_id_federated_identity_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."federated_identity_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federated_identity_claims_target_idx" ON "federated_identity_claims" USING btree ("target");--> statement-breakpoint
CREATE INDEX "federated_identity_claims_subject_idx" ON "federated_identity_claims" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "federated_identity_link_evidence_link_id_idx" ON "federated_identity_link_evidence" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "federated_identity_links_identity_b_idx" ON "federated_identity_links" USING btree ("identity_b");--> statement-breakpoint
CREATE INDEX "federated_identity_links_status_idx" ON "federated_identity_links" USING btree ("status");