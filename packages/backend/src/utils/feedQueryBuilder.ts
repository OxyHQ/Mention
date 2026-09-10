/**
 * Feed Query Builder — the CONTENT predicates the discovery feeds share.
 *
 * ## What this file no longer contains, and why
 *
 * The Mongo original also carried `buildQuery` (plus `buildBaseQuery`,
 * `applyFilters`, `buildSavedPostsQuery`) and four single-feed builders
 * (`buildForYouQuery`, `buildFollowingQuery`, `buildExploreQuery`,
 * `buildMediaQuery`). Every one of them had ZERO production callers at the time
 * of the port — the feed engine's source modules build their own predicates —
 * and the four single-feed builders had no callers at all, not even a test.
 * They are DELETED rather than translated: the migration contract forbids
 * carrying Mongo baggage across, and a dead query builder rewritten into SQL is
 * the most expensive possible form of that.
 *
 * `feedQueryBodyPaths.test.ts` went with them, and it is worth saying why that
 * is not a loss of coverage. It existed because Mongo query keys are STRINGS:
 * a clause still keyed on the retired `content.text` compiled, ran, and matched
 * zero documents, so "matched nothing" was indistinguishable from "nothing to
 * match" unless the query object itself was asserted. In this schema the body is
 * `post_content_variants.body`, reached through a typed drizzle column — a wrong
 * name is a `tsc` error, not a silent empty result. The hazard the test guarded
 * is unrepresentable, so the test has nothing left to guard.
 *
 * ## Predicates, not query objects
 *
 * Both survivors return a drizzle `SQL` condition rather than a mutable match
 * object. Composition is `and(...)` at the call site, which is also why the
 * Mongo-era `$and`-appending helpers are gone: there is no shared mutable map
 * whose `$or` key a later writer can clobber, so the entire class of "the
 * cursor silently dropped the content filter" bug has no analogue here.
 */

import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';
import { and, eq, exists, gt, gte, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { postAttachments, postMedia, posts } from '../db/schema';

export interface VideosQueryOptions {
  /** Minimum video duration in seconds (defaults to {@link MtnConfig.videosFeed.minDurationSec}). */
  minDurationSec?: number;
  /**
   * Restrict to videos with this stored orientation.
   * Omit to use {@link MtnConfig.videosFeed.defaultOrientation} (`portrait`).
   * Pass `'all'` to include every orientation with persisted metadata.
   */
  orientation?: 'portrait' | 'landscape' | 'square' | 'all';
}

/**
 * "This post is not a boost."
 *
 * Mongo needed `{ $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }`
 * because a missing field and a null field were different states. A column is
 * always present, so the disjunction collapses to one `IS NULL` — and unlike
 * `<>`, `IS NULL` is total, so no row is dropped by three-valued logic.
 */
export function notABoostSql(): SQL {
  return isNull(posts.boostOf);
}

/**
 * Exclude post ids the viewer has already been shown.
 *
 * Returns `undefined` for an empty set so the caller can drop the term entirely
 * rather than emit a degenerate `NOT IN ()`. The Mongo original also filtered
 * the incoming ids through `ObjectId.isValid`; that guard is deleted per
 * `@oxy.so/db` — it existed only to dodge a `CastError`, and a text id that names
 * no row already produces exactly the "no such post" answer the caller wanted.
 */
export function excludeSeenSql(seenPostIds: readonly string[]): SQL | undefined {
  if (seenPostIds.length === 0) return undefined;
  return notInArray(posts.id, [...seenPostIds]);
}

/**
 * "This post's author is none of `ids`" — for a NULLABLE author column.
 *
 * `posts.oxy_user_id` is nullable (the raw federated `insertMany` path can omit
 * it, per `db/schema/posts.ts`), and this is where Mongo and SQL disagree in a
 * way that costs rows silently:
 *
 *   - Mongo `{ oxyUserId: { $nin: [a, b] } }` MATCHES a document whose field is
 *     missing or null — absent is trivially "not one of these".
 *   - SQL `oxy_user_id NOT IN (a, b)` evaluates to NULL when the column is NULL,
 *     and a NULL predicate excludes the row.
 *
 * So the direct translation drops every author-less post from Explore and every
 * other feed that excludes the viewer's own follows — with no error, looking
 * exactly like a ranking change. The `IS NULL` arm restores Mongo's semantics.
 */
export function authorNotInSql(ids: readonly string[]): SQL | undefined {
  if (ids.length === 0) return undefined;
  return or(isNull(posts.oxyUserId), notInArray(posts.oxyUserId, [...ids])) as SQL;
}

export class FeedQueryBuilder {
  /**
   * Content predicate for the Videos (Reels) feed.
   *
   * Matches public, published posts carrying at least one video item with
   * persisted metadata: durationSec ≥ min (when known), orientation, width and
   * height. Both native and federated posts are included. Boosts are excluded
   * (the underlying original is surfaced instead). Replies flow through so
   * multi-post threads can still be sliced.
   *
   * UNKNOWN IS NOT A VALUE. Duration applies WHEN KNOWN and abstains when
   * absent. Measured against production (2026-07-30): of 9,465 posts carrying a
   * video media item, `durationSec` is present on 5.9% — and on 0% of the last
   * day's arrivals. A plain `>=` on a mostly-absent field was not enforcing a
   * 20-second policy on the corpus; it was discarding 94% of it and enforcing
   * the policy on the remainder (the shipped default pool was 147 of 9,465).
   * The real fix is upstream — `enrichFromOxy` reads metadata Oxy already holds
   * for 79% of them — and this does not substitute for it.
   *
   * Mongo's `$elemMatch` becomes a correlated `EXISTS`, which is the same
   * semantics: the conditions must all hold on ONE media row, not be spread
   * across several. Built through drizzle's query builder rather than a hand-
   * written `sql` template so the correlated `post_media.post_id = posts.id`
   * renders FULLY QUALIFIED — the failure mode documented in `@oxy.so/db`
   * (both names resolving against the subquery's own table, matching nothing,
   * raising no error) is exactly what this shape would otherwise invite.
   *
   * CONTENT PREDICATE + SEEN SET ONLY — deliberately NO cursor. Every consumer
   * feeds a RANKED pipeline whose page order is a score, not an id, so a cursor
   * bound here would drop candidates on an axis nothing sorts by.
   *
   * ## It STAYS, and its remaining caller is the reason
   *
   * The chronological Videos lane no longer uses this — it drives from
   * `post_media` through {@link FeedQueryBuilder.videoMediaConditions}, because
   * only that direction can reach `post_media_video_chrono_idx`.
   * `popularVideosSource` still does, and should: it orders by the ENGAGEMENT
   * composite, so it reaches its rows through `posts_engagement_rank_idx` and
   * needs exactly what this returns — a cheap yes/no about qualifying media, with
   * set semantics free. Rewriting that one to drive from `post_media` would trade
   * an index it uses for one it cannot order by.
   */
  static buildVideosQuery(
    seenPostIds: readonly string[],
    options: VideosQueryOptions = {},
  ): SQL {
    const minDurationSec = options.minDurationSec ?? MtnConfig.videosFeed.minDurationSec;
    const orientation = options.orientation ?? MtnConfig.videosFeed.defaultOrientation;

    const mediaConditions: SQL[] = [
      eq(postMedia.postId, posts.id),
      eq(postMedia.type, 'video'),
      // Duration when known, abstain when absent.
      or(gte(postMedia.durationSec, minDurationSec), isNull(postMedia.durationSec)) as SQL,
      gt(postMedia.width, 0),
      gt(postMedia.height, 0),
    ];

    // `'all'` is the one setting whose NAME promises no filtering, so it must
    // not compile to a filter.
    if (orientation !== 'all') {
      mediaConditions.push(eq(postMedia.orientation, orientation));
    }

    const conditions: SQL[] = [
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
      exists(
        getDb()
          .select({ one: sql`1` })
          .from(postMedia)
          .where(and(...mediaConditions)),
      ),
      notABoostSql(),
    ];

    const seen = excludeSeenSql(seenPostIds);
    if (seen) conditions.push(seen);

    return and(...conditions) as SQL;
  }

  /**
   * The same video-media rule as {@link FeedQueryBuilder.buildVideosQuery}, but
   * as conditions on `post_media` ITSELF rather than inside a correlated
   * `EXISTS` — for the caller that DRIVES from that table.
   *
   * ## Why there are two of these and neither is redundant
   *
   * They serve opposite scan directions, and each is wrong for the other's.
   *
   * `buildVideosQuery` states the rule as a predicate over `posts`, which is what
   * a query ordering by ENGAGEMENT needs: `popularVideosSource` sorts on the
   * engagement composite, reaches its rows through `posts_engagement_rank_idx`,
   * and only wants a yes/no about whether each candidate has qualifying media. An
   * `EXISTS` also gives it set semantics for free — a post carrying two matching
   * media rows is one post, with no `DISTINCT` anywhere.
   *
   * This one states the rule where the rows are, which is what a query ordering
   * CHRONOLOGICALLY needs: `post_media_video_chrono_idx` is keyed
   * `(type, orientation, post_created_at desc, post_id desc)`, so a scan driving
   * from `post_media` walks matching media in page order and stops at the page.
   * Fed to the `EXISTS` form instead, that index cannot be reached at all — a
   * correlated subquery is evaluated per candidate post, so its own ordering is
   * never asked for.
   *
   * The cost of driving from here is that set semantics stop being free: one post
   * carrying two matching media rows is TWO rows out of the join. The caller owns
   * that — `selectVideoCandidatesByMediaChrono` uses `DISTINCT ON` — and
   * `videosLaneChrono.test.ts` seeds exactly that post to prove it.
   *
   * The `post_media.post_id = posts.id` correlation is deliberately NOT here: the
   * caller expresses it as a JOIN, which is the only form that lets the planner
   * start from this table.
   */
  static videoMediaConditions(options: VideosQueryOptions = {}): SQL {
    const minDurationSec = options.minDurationSec ?? MtnConfig.videosFeed.minDurationSec;
    const orientation = options.orientation ?? MtnConfig.videosFeed.defaultOrientation;

    const conditions: SQL[] = [
      eq(postMedia.type, 'video'),
      // Duration when known, abstain when absent — the same abstention the
      // `EXISTS` form makes, and the reason `duration_sec` is not an index key.
      or(gte(postMedia.durationSec, minDurationSec), isNull(postMedia.durationSec)) as SQL,
      gt(postMedia.width, 0),
      gt(postMedia.height, 0),
    ];

    // `'all'` is the one setting whose NAME promises no filtering, so it must
    // not compile to a filter.
    if (orientation !== 'all') {
      conditions.push(eq(postMedia.orientation, orientation));
    }

    return and(...conditions) as SQL;
  }

  /**
   * The `posts`-side half of the Videos lane: publication state, not a boost, and
   * not already seen — the companion to
   * {@link FeedQueryBuilder.videoMediaConditions} for the media-driven scan,
   * which applies the two halves to the two tables it joins.
   *
   * Identical in meaning to the non-media terms of
   * {@link FeedQueryBuilder.buildVideosQuery}, and the parity is asserted rather
   * than eyeballed: `videosLaneChrono.test.ts` drives both formulations over the
   * fixtures that distinguish them and requires the same posts back.
   */
  static videoPostConditions(seenPostIds: readonly string[]): SQL {
    const conditions: SQL[] = [
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
      notABoostSql(),
    ];

    const seen = excludeSeenSql(seenPostIds);
    if (seen) conditions.push(seen);

    return and(...conditions) as SQL;
  }

  /**
   * Content predicate for the global Media feed.
   *
   * Mirrors {@link FeedQueryBuilder.buildVideosQuery} but widens the content
   * predicate to ANY media attachment rather than videos only: posts typed
   * IMAGE/VIDEO, posts carrying at least one shared media row, or posts carrying
   * a `media` attachment descriptor. Boosts excluded; replies flow through.
   *
   * CONTENT PREDICATE + SEEN SET ONLY — no cursor, for the reason given above.
   *
   * ## This one CANNOT become a media-driven scan, so do not unify it
   *
   * The obvious next step after the Videos lane — drive from `post_media` and use
   * its chronological index — is unavailable here, and not for want of trying.
   * The predicate below is a three-way `OR`: a post qualifies by `posts.type`
   * being IMAGE/VIDEO, OR by having a `post_media` row, OR by carrying a `media`
   * attachment descriptor. The first and third arms match posts with NO
   * `post_media` row at all, so a scan driven from that table cannot see them and
   * the Media feed would silently lose every one — a shorter page, no error. Only
   * the Videos lane can move, because a video post is defined BY its media row.
   */
  static buildMediaFeedQuery(seenPostIds: readonly string[]): SQL {
    const db = getDb();

    const conditions: SQL[] = [
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
      or(
        inArray(posts.type, [PostType.IMAGE, PostType.VIDEO]),
        exists(db.select({ one: sql`1` }).from(postMedia).where(eq(postMedia.postId, posts.id))),
        exists(
          db
            .select({ one: sql`1` })
            .from(postAttachments)
            .where(and(eq(postAttachments.postId, posts.id), eq(postAttachments.type, 'media'))),
        ),
      ) as SQL,
      notABoostSql(),
    ];

    const seen = excludeSeenSql(seenPostIds);
    if (seen) conditions.push(seen);

    return and(...conditions) as SQL;
  }
}
