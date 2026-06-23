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
 *   - Mongo `$match` clauses ({@link SENSITIVE_EXCLUDE_MATCH},
 *     {@link NSFW_HASHTAG_EXCLUDE_MATCH}, {@link DISCOVERY_SAFE_MATCH}) for
 *     query/aggregation-level exclusion, and
 *   - the in-memory predicate ({@link isSfw} / {@link isDiscoverable}) +
 *     {@link filterDiscoverable} for filtering already-fetched lean documents.
 *
 * Both forms encode the SAME definition of "sensitive": a post is sensitive when
 * ANY of the three independent flags is set — the unified classifier verdict
 * (`postClassification.sensitive`), the legacy content-warning flag
 * (`metadata.isSensitive`), or the federated actor's own sensitivity flag
 * (`federation.sensitive`) — OR it carries an NSFW/adult hashtag
 * ({@link isNsfwHashtag}). The Mongo NSFW-hashtag clause keys off the stored
 * canonical `hashtags` array; the predicate additionally covers any caller-shaped
 * post the same way.
 */

import { NSFW_HASHTAGS, isNsfwHashtag } from '../../services/contentClassification/nsfw';

/**
 * Canonical Mongo `$match` clause excluding classifier/metadata/federation-flagged
 * sensitive posts. Spread into a query or `$match` stage:
 * `{ visibility: 'public', ...SENSITIVE_EXCLUDE_MATCH }`. Frozen so a consumer
 * cannot mutate the shared object.
 */
export const SENSITIVE_EXCLUDE_MATCH: Readonly<Record<string, unknown>> = Object.freeze({
  'postClassification.sensitive': { $ne: true },
  'metadata.isSensitive': { $ne: true },
  'federation.sensitive': { $ne: true },
});

/**
 * Canonical Mongo `$match` clause excluding posts whose stored `hashtags` array
 * contains an NSFW/adult-blocklisted tag. Hashtags are stored canonically
 * (lowercase, `#`-stripped), matching the blocklist slugs, so a `$nin` over the
 * blocklist is exact. Frozen so the embedded array can't be mutated.
 */
export const NSFW_HASHTAG_EXCLUDE_MATCH: Readonly<Record<string, unknown>> = Object.freeze({
  hashtags: { $nin: Array.from(NSFW_HASHTAGS) },
});

/**
 * The combined discovery-safety Mongo `$match` clause: excludes BOTH
 * classifier/metadata/federation-flagged sensitive content AND NSFW-hashtag
 * posts. Spread into any discovery query/aggregation `$match`:
 * `{ visibility: 'public', ...DISCOVERY_SAFE_MATCH }`.
 */
export const DISCOVERY_SAFE_MATCH: Readonly<Record<string, unknown>> = Object.freeze({
  ...SENSITIVE_EXCLUDE_MATCH,
  ...NSFW_HASHTAG_EXCLUDE_MATCH,
});

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
  federation?: { sensitive?: boolean | null };
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
