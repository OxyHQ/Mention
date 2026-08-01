/**
 * Feed safety gating — the SINGLE source of truth for discovery sensitivity /
 * NSFW exclusion across every feed and ranking surface.
 *
 * Why this exists: the sensitive/NSFW gate used to be copy-pasted into each feed
 * (and the chronological-vs-discovery split lived per-feed), which is exactly how
 * `ForYouFeed.fetchPopular` ended up MISSING the filter and leaked NSFW into For
 * You. Centralizing it here means adding a new gate — a new flag or a new NSFW
 * term — updates every feed at once, and no surface can silently diverge.
 *
 * Two equivalent forms are exported so callers use whichever fits their data path:
 *   - SQL predicates ({@link sensitiveExcludeSql}, {@link nsfwHashtagExcludeSql},
 *     {@link discoverySafeSql}) for query-level exclusion, and
 *   - the in-memory predicate ({@link isSfw} / {@link isDiscoverable}) +
 *     {@link filterDiscoverable} for filtering already-fetched rows.
 *
 * A third export, {@link requiresContentWarning}, widens the gate for surfaces that
 * cannot render a warning at all (OpenGraph unfurls, plain-text notification
 * previews) — see its own doc for why that is a separate question from "is this
 * post sensitive".
 *
 * Both forms encode the SAME definition of "sensitive": a post is sensitive when
 * ANY of the three independent flags is set — the unified classifier verdict
 * (`classification_sensitive`), the legacy content-warning flag
 * (`metadata_is_sensitive`), or the federated actor's own sensitivity flag
 * (`federation_sensitive`) — OR it carries an NSFW/adult hashtag
 * ({@link isNsfwHashtag}). The SQL NSFW-hashtag predicate keys off the stored
 * canonical `hashtags` array; the in-memory predicate additionally covers any
 * caller-shaped post the same way.
 */

import { sql, type SQL } from 'drizzle-orm';
import { qualified } from '../../db/casing';
import { inList } from '../../db/schema/columns';
import { posts } from '../../db/schema/posts';
import { NSFW_HASHTAGS, isNsfwHashtag } from '../../services/contentClassification/nsfw';

/**
 * Mongo `$match` clauses — RETAINED ONLY for the consumers that are still on
 * Mongoose, and deleted by the batch that ports them.
 *
 * `routes/search.ts` and `services/TrendingService.ts` still issue Mongo
 * queries. A helper that spans an unfinished, deliberately BATCHED cutover has
 * to speak both stores for exactly as long as that is true, and the alternative
 * — each of those files inlining its own copy of the sensitive-flag rule — is
 * how this module came to exist in the first place (`ForYouFeed.fetchPopular`
 * shipped without the filter and leaked NSFW into For You).
 *
 * The three flags are stated ONCE per store, immediately adjacent, so a reviewer
 * comparing them sees both in one screen.
 */
export const SENSITIVE_EXCLUDE_MATCH: Readonly<Record<string, unknown>> = Object.freeze({
  'postClassification.sensitive': { $ne: true },
  'metadata.isSensitive': { $ne: true },
  'federation.sensitive': { $ne: true },
});

/** Mongo counterpart of {@link nsfwHashtagExcludeSql}. See above for its lifetime. */
export const NSFW_HASHTAG_EXCLUDE_MATCH: Readonly<Record<string, unknown>> = Object.freeze({
  hashtags: { $nin: Array.from(NSFW_HASHTAGS) },
});

/** Mongo counterpart of {@link discoverySafeSql}. See above for its lifetime. */
export const DISCOVERY_SAFE_MATCH: Readonly<Record<string, unknown>> = Object.freeze({
  ...SENSITIVE_EXCLUDE_MATCH,
  ...NSFW_HASHTAG_EXCLUDE_MATCH,
});

/**
 * The Postgres form of {@link SENSITIVE_EXCLUDE_MATCH}, for `posts`.
 * Compose at the call site: `and(eq(posts.visibility, 'public'), sensitiveExcludeSql())`.
 *
 * Two ports of this predicate were written independently and merged here; where
 * they differed, both reasons are kept because each covers something the other
 * does not.
 *
 * `is not true` — equivalently `is distinct from true` — rather than `<> true`
 * or `= false`, is the whole translation of Mongo's `$ne: true`: two of the three
 * columns are NULLABLE (a post that was never classified, a local post with no
 * federation subdocument), and `<>` against NULL yields NULL, so a `where` built
 * that way would silently DROP every unclassified post from every discovery
 * surface. `is not true` is TRUE for both `false` and NULL, which is exactly the
 * set `$ne: true` matched.
 *
 * Every column reference is `qualified()`, and these are the clauses where that
 * matters most: they are SHARED, so unlike a predicate written inline they have
 * no idea what statement they will end up in. Measured against drizzle 0.45.2,
 * an interpolated column loses its table prefix in exactly one position — the
 * SELECT LIST of a single-table select — and whether a query is single-table is
 * a property that flips the moment someone adds or removes a join. Qualifying
 * makes the rendering independent of all that. The cost is that these clauses
 * only work against `posts` UNALIASED, which is how every caller uses it.
 *
 * These are functions rather than exported `SQL` constants so that every call
 * site gets its own instance; a shared frozen predicate is fine today but makes
 * any future per-caller parameterisation a breaking change across 20-odd sites.
 */
export function sensitiveExcludeSql(): SQL {
  return sql`(
    ${qualified(posts.classificationSensitive)} is not true
    and ${qualified(posts.metadataIsSensitive)} is not true
    and ${qualified(posts.federationSensitive)} is not true
  )`;
}

/**
 * The Postgres form of {@link NSFW_HASHTAG_EXCLUDE_MATCH}, for `posts`.
 *
 * `&&` is array OVERLAP, so `not (hashtags && blocklist)` is "no stored hashtag is
 * on the blocklist" — Mongo's `$nin` over a multikey field. Hashtags are stored
 * canonically (lowercase, `#`-stripped), matching the blocklist slugs, so the
 * overlap is exact.
 *
 * The `coalesce(…, false)` is load-bearing, not defensive noise: `posts.hashtags`
 * is NULLABLE (`default: undefined` in Mongo meant "absent", which the schema
 * preserves as a column with no default), `NULL && ARRAY[…]` is NULL, and a bare
 * `NOT NULL` is NULL — so without it every post that never got a hashtag, the
 * overwhelming majority, silently vanishes from every discovery feed with no
 * error. Mongo's `$nin` INCLUDED exactly those documents.
 *
 * The blocklist is rendered as SQL literals from the same `NSFW_HASHTAGS` set the
 * in-memory predicate reads, so the two cannot drift. `inList` is safe here for
 * the same reason it is safe in the schema's CHECK constraints: the values are a
 * locally-declared set of identifier-shaped literals, never a runtime value.
 */
export function nsfwHashtagExcludeSql(): SQL {
  return sql`not coalesce(${qualified(posts.hashtags)}
    && array[${sql.raw(inList([...NSFW_HASHTAGS]))}]::text[], false)`;
}

/** The Postgres form of {@link DISCOVERY_SAFE_MATCH}, for `posts`. */
export function discoverySafeSql(): SQL {
  return sql`(${sensitiveExcludeSql()} and ${nsfwHashtagExcludeSql()})`;
}

/**
 * The minimal post shape the in-memory predicate reads. A lean Mongo document
 * carrying any of the sensitive flags and/or `hashtags` satisfies it; every field
 * is optional so it works for native, federated, baselined, and not-yet-classified
 * posts alike.
 */
export interface FeedSafetyPostShape {
  hashtags?: string[];
  postClassification?: { sensitive?: boolean | null };
  metadata?: { isSensitive?: boolean | null };
  federation?: { sensitive?: boolean | null; spoilerText?: string | null };
}

/**
 * Whether a post is sensitive/NSFW and therefore must be kept OUT of discovery
 * surfaces and ranked feeds. The in-memory counterpart to
 * {@link DISCOVERY_SAFE_MATCH}, so every surface (candidate merge, popular
 * fallback, ranking guard) agrees on what "sensitive" means.
 *
 * A post is sensitive when ANY of these hold:
 *   - the deterministic/AI classifier flagged it (`postClassification.sensitive`),
 *   - the app metadata flag is set (`metadata.isSensitive`),
 *   - the federating source flagged it (`federation.sensitive`), or
 *   - it carries an NSFW/adult hashtag ({@link isNsfwHashtag}).
 *
 * NEUTRAL by default: a clean post (or nullish input) returns `false`.
 */
export function isSensitivePost(post: FeedSafetyPostShape | null | undefined): boolean {
  if (!post) return false;
  if (post.postClassification?.sensitive === true) return true;
  if (post.metadata?.isSensitive === true) return true;
  if (post.federation?.sensitive === true) return true;
  const tags = post.hashtags;
  if (Array.isArray(tags) && tags.some(isNsfwHashtag)) return true;
  return false;
}

/**
 * Whether a post is safe-for-work and may appear in discovery / ranked feeds —
 * the inverse of {@link isSensitivePost}. Use this as the positive filter
 * predicate: `posts.filter(isSfw)`.
 */
export function isSfw(post: FeedSafetyPostShape | null | undefined): boolean {
  return !isSensitivePost(post);
}

/**
 * Whether a post is discoverable (SFW) — an intent-revealing alias of
 * {@link isSfw} for discovery call sites.
 */
export const isDiscoverable = isSfw;

/**
 * Filter a list of posts down to the discoverable (SFW) ones, preserving order.
 * The single helper every feed uses to drop sensitive/NSFW from an
 * already-fetched pool.
 */
export function filterDiscoverable<T extends FeedSafetyPostShape>(posts: T[]): T[] {
  return posts.filter(isSfw);
}

/**
 * Whether the post carries a federated content warning (ActivityPub `summary` —
 * Mastodon's CW), which the app renders as a spoiler header gating the body.
 *
 * Deliberately NOT folded into {@link isSensitivePost}: a CW is an instruction about
 * HOW to present the post, not a claim that it is NSFW, and a remote server sets
 * `summary` without setting `sensitive` on plenty of text-only posts. Feeds keep
 * carrying those (the client shows the spoiler); only surfaces that cannot show a
 * warning need to care — see {@link requiresContentWarning}.
 */
export function hasFederatedContentWarning(post: FeedSafetyPostShape | null | undefined): boolean {
  const spoiler = post?.federation?.spoilerText;
  return typeof spoiler === 'string' && spoiler.trim().length > 0;
}

/**
 * Whether this post may only be shown BEHIND a warning — sensitive/NSFW
 * ({@link isSensitivePost}) or carrying a content warning
 * ({@link hasFederatedContentWarning}).
 *
 * This is the gate for surfaces that render content RAW, with no affordance to show
 * a warning first and no way for the person seeing it to opt in: an OpenGraph
 * unfurl in a group chat, or a plain-text notification preview. Those surfaces must
 * WITHHOLD such content — the in-app warning is the whole reason it is safe to
 * carry it anywhere else, so a surface that cannot reproduce the warning cannot
 * reproduce the content either.
 *
 * Feeds and ranking deliberately keep using the narrower {@link isSensitivePost}:
 * their client CAN render a spoiler, so a CW'd post belongs in them.
 */
export function requiresContentWarning(post: FeedSafetyPostShape | null | undefined): boolean {
  return isSensitivePost(post) || hasFederatedContentWarning(post);
}
