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
 *   - CHOSEN lanes (following / subscribed lists): NEVER filtered. A post from an
 *     account the reader deliberately followed is the reader's own business,
 *     whatever language it is in.
 *   - AFFINITY: FILTERED, despite being `trusted` to the discovery gate.
 *     `resolveAffinityAuthorIds` excludes everyone the viewer follows, so the lane
 *     is by construction "people you did not choose". Engagement vouches for an
 *     author's quality; it does not teach the reader a language.
 *   - Discover (`explore`), Videos and Media: FILTERED. Discover was exempt at
 *     first, as the open window on the whole network — but measured on production
 *     2026-09-05 the window was 56% `ja`, from misskey.io / fedibird.com posts
 *     carrying likes=0, replies=0 and only federated boosts, riding pure recency.
 *     An open window onto one language nobody asked for is not discovery.
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
import { arrayOverlaps, type SQL } from 'drizzle-orm';
import { posts } from '../../db/schema';
import { isDiscoveryLanguageFilterEnabled } from '../../config';

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
 * A post with NO resolvable language does not match: an unverifiable language is
 * not a match. Measured cost is 1.9% of production (4 of 212 sampled posts) —
 * measured on `classification_languages` itself, since the scalar `language`
 * diverges from it and reads lower. What it drops is media-only/sub-12-character
 * posts plus legacy pre-port rows the language backfill has not swept.
 *
 * This was briefly an `allowUnclassified` config knob. It was not one: `MtnConfig`
 * is `as const`, so the flag's type was the literal `false` and the widening
 * branch behind it could never execute — a documented lever that was really a
 * dead branch.
 *
 * @param viewerLanguages ISO 639-1 base subtags, primary first. Already
 *   normalized by `loadViewerFeedContext`.
 */
export function viewerLanguageSql(viewerLanguages: readonly string[] | undefined): SQL | undefined {
  // Cheapest guard first. Both branches return `undefined`, so the order is only
  // about cost: an undeclared reader (anonymous, no `Accept-Language`) is the
  // common case on the anonymous feed, and this way they never reach the env
  // parse behind the flag.
  if (!viewerLanguages || viewerLanguages.length === 0) return undefined;
  if (!(isDiscoveryLanguageFilterEnabled() ?? MtnConfig.feed.discoveryLanguage.enabled)) {
    return undefined;
  }

  return arrayOverlaps(posts.classificationLanguages, [...viewerLanguages]);
}
