ALTER TABLE "trending" ADD COLUMN "regions" text[];--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "concept_id" text;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "localized_labels" jsonb;--> statement-breakpoint
ALTER TABLE "trending" ADD CONSTRAINT "trending_scope_check" CHECK ("trending"."scope" is null or "trending"."scope" in ('global', 'multilingual', 'regional', 'language', 'community'));