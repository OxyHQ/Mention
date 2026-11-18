-- oxy:deploy-phase=pre
-- Three closed vocabularies gain one word each: the `child_safety` report
-- category, the `legal_referral` enforcement action and the `report.refer`
-- outbox kind (referral to Oxy's claim review, oxy ADR 0043 D14). Additive: the
-- previous release writes none of them, so applying this before the rollout is safe.
ALTER TABLE "moderation_enforcements" DROP CONSTRAINT "moderation_enforcements_action_check";--> statement-breakpoint
ALTER TABLE "moderation_outbox" DROP CONSTRAINT "moderation_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_enforced_action_check";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_categories_check";--> statement-breakpoint
ALTER TABLE "moderation_enforcements" ADD CONSTRAINT "moderation_enforcements_action_check" CHECK ("moderation_enforcements"."action" in ('none', 'restrict', 'restore', 'label_sensitive', 'unlabel_sensitive', 'manual_review', 'legal_referral'));--> statement-breakpoint
ALTER TABLE "moderation_outbox" ADD CONSTRAINT "moderation_outbox_kind_check" CHECK ("moderation_outbox"."kind" in ('report.submit', 'decision.apply', 'report.refer'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_enforced_action_check" CHECK ("reports"."enforced_action" is null or "reports"."enforced_action" in ('none', 'restrict', 'restore', 'label_sensitive', 'unlabel_sensitive', 'manual_review', 'legal_referral'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_categories_check" CHECK (array_length("reports"."categories", 1) >= 1
        and "reports"."categories" <@ array['spam', 'hate_speech', 'harassment', 'misinformation', 'explicit_content', 'child_safety', 'scam', 'discriminatory', 'impersonation', 'already_filled', 'duplicate', 'other']::text[]);