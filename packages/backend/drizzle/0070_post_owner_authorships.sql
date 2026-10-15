-- Give every authored post the owner authorship row it is projected from.
--
-- `posts.oxy_user_id` is the denormalized projection of the post's `owner` row
-- in `post_authorships`, which is the authority (`replacePostAuthorship`), and
-- post hydration resolves a post's author THROUGH that row. In production
-- (2026-10-15) 259 public posts had an author but no authorship row at all:
-- legacy federated posts stored before ingest enforced the author link, whose
-- author `federatedProfileSync` later filled in on `posts` alone (fixed in the
-- same change). Each one hydrated with a nameless placeholder author, so the web
-- shell answered every request for its page with a 503 ("post author did not
-- resolve") — 43 of the 74 web-shell 503s on 2026-10-14, reproduced on three of
-- them with a plain GET.
--
-- The row is exactly what ingest writes for a post's owner: accepted, with the
-- post's own `created_at` copied into `post_created_at` (0021). Ids are uuid v7
-- stamped with the post's creation time, the shape `generatedId()` mints, built
-- the way 0053 builds them since Postgres 17 has no `uuidv7()`.
--
-- One anti-join of `posts` against the owner rows (5.6 s read-only in
-- production); it locks no `posts` row against writers. Bounded at 60 s.
SELECT set_config('mention.owner_authorship_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
INSERT INTO "post_authorships" ("id", "post_id", "oxy_user_id", "role", "status", "post_created_at")
SELECT
	substr(o.ts, 1, 8) || '-' || substr(o.ts, 9, 4) || '-7' || substr(o.rnd, 1, 3) || '-'
		|| substr('89ab', 1 + floor(random() * 4)::int, 1) || substr(o.rnd, 4, 3) || '-'
		|| substr(o.rnd, 7, 12),
	o.post_id,
	o.oxy_user_id,
	'owner',
	'accepted',
	o.created_at
FROM (
	SELECT
		p.id AS post_id,
		p.oxy_user_id,
		p.created_at,
		lpad(to_hex(floor(extract(epoch FROM p.created_at) * 1000)::bigint), 12, '0') AS ts,
		md5(random()::text || clock_timestamp()::text || p.id) AS rnd
	FROM "posts" p
	WHERE p.oxy_user_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM "post_authorships" a WHERE a.post_id = p.id AND a.role = 'owner'
		)
) o
ON CONFLICT ("post_id", "oxy_user_id") DO NOTHING;
--> statement-breakpoint
SELECT set_config('statement_timeout', current_setting('mention.owner_authorship_statement_timeout'), true);
