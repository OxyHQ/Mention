-- oxy:deploy-phase=pre
-- Validate separately so the widened checks do not scan under ACCESS EXCLUSIVE.
ALTER TABLE "oxy_file_reference_reconciliations" VALIDATE CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check";
--> statement-breakpoint
ALTER TABLE "oxy_file_reference_sync" VALIDATE CONSTRAINT "oxy_file_reference_sync_entity_type_check";
