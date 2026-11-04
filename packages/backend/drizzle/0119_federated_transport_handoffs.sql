-- oxy:deploy-phase=pre
-- The per-account instant posts stop coming from a keyless transport and start
-- coming from a keyed one (see `federatedTransportHandoffs` in
-- `src/db/schema/federation.ts`). A new, empty table; no lock on any existing table.
CREATE TABLE "federated_transport_handoffs" (
	"network_acct" text PRIMARY KEY NOT NULL,
	"handoff_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
