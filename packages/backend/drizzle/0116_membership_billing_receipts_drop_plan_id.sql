-- oxy:deploy-phase=post
-- `plan_id` was the Stripe-Billing proxy's plan reference. Receipts now bind to
-- Peable's native objects, where the price (`provider_price_id`) is the whole
-- commercial identity: a Peable price never changes what it charges. No release
-- ever wrote a row (the reviewed catalogue has been empty since the table was
-- created, and the only writer refuses before any read or write without an
-- entry), and the erasure steps that touch the table return `id` only, so a
-- task still on the previous release never names this column.
ALTER TABLE "membership_billing_receipts" DROP COLUMN "plan_id";
