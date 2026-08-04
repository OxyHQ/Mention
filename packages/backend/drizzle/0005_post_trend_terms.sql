ALTER TABLE "posts" ADD COLUMN "classification_trend_terms" text[];--> statement-breakpoint
CREATE INDEX "posts_classification_trend_terms_gin" ON "posts" USING gin ("classification_trend_terms");