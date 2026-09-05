/**
 * Feed language gating — the SINGLE source of truth for the reader-language
 * predicate applied to DISCOVERY candidates.
 *
 * Why this exists, in the same shape and for the same reason as {@link
 * ./feedSafety}: the language rule was previously spread across a soft ranking
 * penalty (`languageMismatchPenalty`), a per-lane `arrayOverlaps` that read a
 * DIFFERENT input (the learned `preferredLanguages`), and a tuner that was never
 * fed — and the one surface nobody wired, `popularSource`, is the whole
 * anonymous For You feed. Measured against production on 2026-09-05, that feed
 * was 48% `de` for a corpus that is 6.8% `de`: a 7x over-selection, because
 * engagement was the only axis the discovery lanes sorted on.
 *
 * SCOPE — this is deliberately NOT applied everywhere:
 *   - DISCOVERY lanes (topics / region / trending / global) and the popular
 *     fallback: FILTERED. Nobody asked for these posts, so they have to be
 *     readable to be worth a slot.
 *   - TRUSTED lanes (following / affinity / subscribed lists): NEVER filtered. A
 *     post from an account the reader deliberately follows is the reader's own
 *     business, whatever language it is in.
 *   - Discover (`explore`): NEVER filtered. It is the open window on the whole
 *     network and keeps only its in-language relevance BOOST.
 *
 * It is a SQL predicate rather than an in-memory filter because each discovery
 * lane is capped at 15–30 rows: filtering after the fetch shrinks the pool,
 * where filtering inside it spends the cap on posts the reader can read.
 *
 * UNITS. The reader's languages arrive as ISO 639-1 BASE subtags (`es`, not
 * `es-ES`) — `loadViewerFeedContext` normalizes once, at the boundary, so no
 * call site re-derives them. `posts.classification_languages` stores the same
 * base form, so the comparison is a direct `&&` array overlap served by the
 * existing `posts_classification_languages_gin` index.
 */

import { MtnConfig } from '@mention/shared-types';
import { arrayOverlaps, isNull, or, sql, type SQL } from 'drizzle-orm';
import { posts } from '../../db/schema';
import { isDiscoveryLanguageFilterEnabled } from '../../config';

/**
 * Whether the discovery language filter is active. The env flag
 * (`FOR_YOU_DISCOVERY_LANGUAGE=off`) wins over the config default so the filter
 * can be rolled back at runtime, exactly like the discovery gate beside it.
 */
export function isDiscoveryLanguageEnabled(): boolean {
  return isDiscoveryLanguageFilterEnabled() ?? MtnConfig.feed.discoveryLanguage.enabled;
}

/**
 * The reader-language predicate for a DISCOVERY query, or `undefined` when no
 * predicate should be applied.
 *
 * Returns `undefined` — i.e. filters NOTHING — when the filter is disabled or
 * when `viewerLanguages` is empty. An empty set means the reader's languages are
 * UNKNOWN (an anonymous request with no `Accept-Language`, an account with no
 * locales, or a failed lookup), and an unknown reader must never be filtered,
 * only an unmatched one. That is the same fail-soft contract
 * `languageMismatchPenalty` already holds.
 *
 * `allowUnclassified` widens the match to posts with no resolvable language.
 * Default `false`: an unverifiable language is not a match. Measured cost is 1.9%
 * of production (4 of 212 sampled posts) — measured on `classification_languages`
 * itself, since the scalar `language` diverges from it and reads lower. What it
 * drops is media-only/sub-12-character posts plus legacy pre-port rows the
 * language backfill has not swept; see `MtnConfig.feed.discoveryLanguage`.
 *
 * @param viewerLanguages ISO 639-1 base subtags, primary first. Already
 *   normalized by `loadViewerFeedContext`.
 */
export function viewerLanguageSql(viewerLanguages: readonly string[] | undefined): SQL | undefined {
  if (!isDiscoveryLanguageEnabled()) return undefined;
  if (!viewerLanguages || viewerLanguages.length === 0) return undefined;

  const match = arrayOverlaps(posts.classificationLanguages, [...viewerLanguages]);
  if (!MtnConfig.feed.discoveryLanguage.allowUnclassified) return match;

  // A NULL array and an EMPTY array are distinct in Postgres and both mean "no
  // resolvable language" here, so the escape has to test each one.
  return or(
    match,
    isNull(posts.classificationLanguages),
    sql`cardinality(${posts.classificationLanguages}) = 0`,
  );
}
