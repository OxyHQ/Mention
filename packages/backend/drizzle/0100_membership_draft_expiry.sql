-- oxy:deploy-phase=pre
CREATE INDEX "membership_media_draft_expiry_idx" ON "membership_media" USING btree ("created_at","id") WHERE "membership_media"."content_id" is null;