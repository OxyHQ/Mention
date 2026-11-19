-- oxy:deploy-phase=pre
-- The widened CHECK is a superset. SHARE UPDATE EXCLUSIVE permits normal DML.
ALTER TABLE "post_attachments" VALIDATE CONSTRAINT "post_attachments_type_check";
