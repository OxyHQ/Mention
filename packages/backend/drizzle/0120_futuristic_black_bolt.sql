-- oxy:deploy-phase=pre
-- Widens the reports type check to accept `trend`. Additive: the previous release
-- never writes `trend`, so applying this before the rollout is safe.
ALTER TABLE "reports" DROP CONSTRAINT "reports_reported_type_check";--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_type_check" CHECK ("reports"."reported_type" in ('post', 'user', 'comment', 'message', 'room', 'job', 'trend'));