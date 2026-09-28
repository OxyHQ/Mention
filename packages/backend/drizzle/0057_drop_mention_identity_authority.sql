-- Drop Mention's retired identity-authority tables (OxyHQ/oxy#1253, step 8).
--
-- Oxy is the single authority for external identities and person equivalence.
-- `federated_identity_claims`, `federated_identity_links` and
-- `federated_identity_link_evidence` were written only by Mention's old
-- equivalence resolver and manual attestation script, both deleted; nothing
-- reads them. Clean cut: no data is carried anywhere.
--
-- Evidence first (it references links); `IF EXISTS` for the same reason as
-- `0024`: the post-condition is absence, asserted by
-- `__tests__/db/identityAuthorityDropped.test.ts`.
DROP TABLE IF EXISTS "federated_identity_link_evidence";--> statement-breakpoint
DROP TABLE IF EXISTS "federated_identity_links";--> statement-breakpoint
DROP TABLE IF EXISTS "federated_identity_claims";
