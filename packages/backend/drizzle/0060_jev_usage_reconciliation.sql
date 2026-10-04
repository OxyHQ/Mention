ALTER TABLE "post_evaluations" ADD COLUMN "receipt_authority" jsonb;--> statement-breakpoint
ALTER TABLE "post_evaluations" ADD COLUMN "request_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_evaluations" ADD COLUMN "usage_reconciliation" jsonb;