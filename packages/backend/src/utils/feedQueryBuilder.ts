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
 * `db/ids.ts` — it existed only to dodge a `CastError`, and a text id that names
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

/**
 * Render a ranking weight as a SQL `double precision` LITERAL.
 *
 * Not a bound parameter, and this is not a style choice. Drizzle infers a bound
 * parameter's type from the expression it sits next to, so
 * `${posts.statsBoostsCount} * ${2.5}` declares `$n` as `int4` — from the
 * COLUMN — and Postgres then rejects the value with
 * `invalid input syntax for type integer: "2.5"`. Every ranking weight is
 * fractional, so the whole composite fails at RUNTIME while compiling and
 * type-checking perfectly.
 *
 * The cast has to be on the LITERAL rather than on the surrounding expression:
 * a parameter's type is fixed at Parse time, before any outer `::double
 * precision` is reached.
 *
 * `sql.raw` is safe here and only here because the input is a number from a
 * compile-time config object, never user input — and the guard makes that a
 * checked property rather than an assumption.
 */
export function rankingWeight(value: number): SQL {
  if (!Number.isFinite(value)) {
    throw new Error(`Ranking weight must be a finite number, received ${String(value)}`);
  }
  return sql.raw(`${value}::double precision`);
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
   * renders FULLY QUALIFIED — the failure mode documented in `db/casing.ts`
   * (both names resolving against the subquery's own table, matching nothing,
   * raising no error) is exactly what this shape would otherwise invite.
   *
   * CONTENT PREDICATE + SEEN SET ONLY — deliberately NO cursor. Every consumer
   * feeds a RANKED pipeline whose page order is a score, not an id, so a cursor
   * bound here would drop candidates on an axis nothing sorts by.
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
   * Content predicate for the global Media feed.
   *
   * Mirrors {@link FeedQueryBuilder.buildVideosQuery} but widens the content
   * predicate to ANY media attachment rather than videos only: posts typed
   * IMAGE/VIDEO, posts carrying at least one shared media row, or posts carrying
   * a `media` attachment descriptor. Boosts excluded; replies flow through.
   *
   * CONTENT PREDICATE + SEEN SET ONLY — no cursor, for the reason given above.
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
