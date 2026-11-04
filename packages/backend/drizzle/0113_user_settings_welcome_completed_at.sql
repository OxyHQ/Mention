-- oxy:deploy-phase=pre
-- When an account finished the first-run /welcome flow. Every account that exists
-- now is stamped as done (a constant default is metadata-only, no table rewrite),
-- then the default goes so a row created from here on starts NULL and is sent to
-- /welcome once. Two catalog-only ALTERs on user_settings, nothing else.
ALTER TABLE "user_settings" ADD COLUMN "welcome_completed_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "welcome_completed_at" DROP DEFAULT;
