-- Job locations and salary currencies become closed, structured values
-- (Clarity Jobs' validated ingest contract, @clarity.surf/sdk 0.3.0).
--
-- Existing rows held free text. What survives, and why:
--   * location_country_code: kept, upper-cased and trimmed, only when it is an
--     ISO 3166-1 alpha-2 code in COUNTRY_CODES (as of SDK 0.3.0); otherwise NULL.
--   * location_region / location_city: always NULL. They were typed by hand and
--     never resolved to a place, and a region/city now exists only as a fact
--     DERIVED from a GeoNames place. Guessing a place from them is exactly the
--     invention the new contract forbids; the employer re-picks the place.
--   * location_raw: dropped. A row whose only location was free text ends with
--     no location (or with its country, when the country code was valid).
--   * salary: kept, with its currency upper-cased and trimmed, only when the
--     currency is in CURRENCY_CODES, the interval is known, no amount is
--     negative, and at least one amount is stated. Otherwise the whole salary is
--     cleared — the salary CHECK makes it all-or-nothing, and an amount in an
--     unknown currency is not a fact Clarity (or a reader) can act on.
-- The code lists are embedded as they stood when this migration was written:
-- a migration is history and must not change meaning when the SDK moves.
ALTER TABLE "mention_jobs" ADD COLUMN "location_place_id" text;--> statement-breakpoint
UPDATE "mention_jobs"
SET
  "location_country_code" = CASE
    WHEN upper(btrim("location_country_code")) = ANY (array[
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
]::text[])
    THEN upper(btrim("location_country_code"))
    ELSE NULL
  END,
  "location_region" = NULL,
  "location_city" = NULL
WHERE "location_country_code" IS NOT NULL
   OR "location_region" IS NOT NULL
   OR "location_city" IS NOT NULL;--> statement-breakpoint
UPDATE "mention_jobs"
SET "salary_currency" = upper(btrim("salary_currency"))
WHERE "salary_currency" IS NOT NULL;--> statement-breakpoint
UPDATE "mention_jobs"
SET "salary_min" = NULL, "salary_max" = NULL, "salary_currency" = NULL, "salary_interval" = NULL
WHERE ("salary_currency" IS NOT NULL OR "salary_interval" IS NOT NULL OR "salary_min" IS NOT NULL OR "salary_max" IS NOT NULL)
  AND (
    "salary_currency" IS NULL
    OR NOT ("salary_currency" = ANY (array[
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BHD', 'BIF',
  'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD',
  'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR',
  'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW',
  'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK',
  'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR',
  'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP',
  'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU',
  'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW',
  'ZWG'
]::text[]))
    OR "salary_interval" IS NULL
    OR "salary_interval" NOT IN ('hour', 'day', 'week', 'month', 'year')
    OR ("salary_min" IS NULL AND "salary_max" IS NULL)
    OR "salary_min" < 0
    OR "salary_max" < 0
  );--> statement-breakpoint
ALTER TABLE "mention_jobs" DROP COLUMN "location_raw";--> statement-breakpoint
ALTER TABLE "mention_jobs" ADD CONSTRAINT "mention_jobs_salary_currency_check" CHECK ("mention_jobs"."salary_currency" is null or "mention_jobs"."salary_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "mention_jobs" ADD CONSTRAINT "mention_jobs_salary_interval_check" CHECK ("mention_jobs"."salary_interval" is null or "mention_jobs"."salary_interval" in ('hour', 'day', 'week', 'month', 'year'));--> statement-breakpoint
ALTER TABLE "mention_jobs" ADD CONSTRAINT "mention_jobs_salary_amount_check" CHECK (("mention_jobs"."salary_min" is null or "mention_jobs"."salary_min" >= 0) and ("mention_jobs"."salary_max" is null or "mention_jobs"."salary_max" >= 0));--> statement-breakpoint
ALTER TABLE "mention_jobs" ADD CONSTRAINT "mention_jobs_location_country_code_check" CHECK ("mention_jobs"."location_country_code" is null or "mention_jobs"."location_country_code" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "mention_jobs" ADD CONSTRAINT "mention_jobs_location_place_check" CHECK ("mention_jobs"."location_place_id" is null or ("mention_jobs"."location_place_id" ~ '^[1-9][0-9]*$' and "mention_jobs"."location_country_code" is not null));--> statement-breakpoint
ALTER TABLE "mention_jobs" ADD CONSTRAINT "mention_jobs_location_derived_check" CHECK ("mention_jobs"."location_place_id" is not null or ("mention_jobs"."location_region" is null and "mention_jobs"."location_city" is null));