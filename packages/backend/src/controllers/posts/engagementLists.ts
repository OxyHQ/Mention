/**
 * The engagement READ lists — who liked a post, which of the people you follow
 * liked it, and who boosted it.
 *
 * All three page identically and embed the canonical Oxy user, so the page
 * bound and the actor mapping are shared rather than repeated per handler.
 */

import { Response } from 'express';
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { likes as likesTable } from '../../db/schema/engagement';
import { posts as postsTable } from '../../db/schema/posts';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../../mtn/feed/CursorBuilder';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { PostUser } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { resolveUserSummaries, degradedActorSummary } from '../../services/PostHydrationService';
import { config } from '../../config';
import { createScopedOxyClient } from '../../utils/oxyHelpers';
import { extractFollowingIds } from '../../utils/privacyHelpers';
import { queryInt, queryString } from '../../utils/queryParams';
import { MAX_PAGE_SIZE } from './postPageBounds';

const DEFAULT_LIKES_LIMIT = config.posts.defaultLikesLimit;

/**
 * Page size for the engagement lists (`GET /posts/:id/likes` and `.../boosts`).
 * Both handlers read the page's last row by index (`rows[limit - 1]`), so the
 * limit has to be a bounded positive integer: an absent, zero, or negative limit
 * would index outside the page and throw on the missing document.
 */
const clampLikesLimit = (limit: number | undefined): number =>
  Math.min(Math.max(limit || DEFAULT_LIKES_LIMIT, 1), MAX_PAGE_SIZE);

/**
 * Resolve the canonical Oxy {@link PostUser} for an engagement-list entry
 * (`GET /posts/:id/likes` and `GET /posts/:id/boosts`). Oxy owns identity, so the
 * response embeds the raw Oxy user (same shape as `post.user` / Who-to-follow):
 * `name.displayName`, `avatar` file id, `username`, `verified`, `isFederated`,
 * `federation`. When the resolver could not resolve a user, fall back to the
 * degraded user (neutral name, EMPTY username) — never the raw id as a handle,
 * which would render a ghost `@<oxyUserId>` and a broken profile link.
 */
const mapActorSummary = (
  userId: string,
  user: PostUser | undefined,
): PostUser => user ?? degradedActorSummary(userId);

// Get users who liked a post
export const getPostLikes = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cursor = queryString(req.query.cursor);
    const limit = clampLikesLimit(queryInt(req.query.limit));

    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    // `(created_at DESC, id DESC)`, not `_id DESC`. `likes.id` is `text` holding
    // an ObjectId hex for a row migrated from Mongo and a uuid v7 for anything
    // written since, and the two spaces interleave under text collation — so an
    // id-only bound behind an id-only sort is neither chronological nor stable
    // across the boundary, and would skip and repeat rows at every page edge.
    // Same keyset `getPostBoosts` below already uses.
    const conditions: SQL[] = [eq(likesTable.postId, String(id))];
    const parsedCursor = ChronoCursor.parse(cursor);
    if (parsedCursor?.ts !== undefined) {
      const boundaryAt = new Date(parsedCursor.ts);
      conditions.push(
        or(
          lt(likesTable.createdAt, boundaryAt),
          and(eq(likesTable.createdAt, boundaryAt), lt(likesTable.id, parsedCursor.id)),
        ) as SQL,
      );
    }

    const likes = await getDb()
      .select({ id: likesTable.id, userId: likesTable.userId, createdAt: likesTable.createdAt })
      .from(likesTable)
      .where(and(...conditions))
      .orderBy(desc(likesTable.createdAt), desc(likesTable.id))
      .limit(limit + 1);

    const hasMore = likes.length > limit;
    const likesToReturn = hasMore ? likes.slice(0, limit) : likes;
    const last = likesToReturn[likesToReturn.length - 1];
    const nextCursor = hasMore && last ? ChronoCursor.build(last.id, last.createdAt) : undefined;

    // Get unique user IDs, then resolve actor summaries through the same shared
    // resolver PostHydrationService uses (canonical `name.displayName`, batched
    // bulk fetch, Redis-cached) instead of N hand-built per-id Oxy reads.
    const userIds = [...new Set(likesToReturn.map(like => like.userId))];
    const summaries = await resolveUserSummaries(userIds);
    const users = userIds.map((userId) => mapActorSummary(userId, summaries.get(userId)?.user));

    res.json({
      users,
      hasMore,
      nextCursor,
      totalCount: likesToReturn.length
    });
  } catch (error) {
    logger.error('Error fetching post likes', error);
    res.status(500).json({ message: 'Error fetching post likes' });
  }
};

/**
 * Avatars shown in the known-likers row. Deliberately tiny: this is a face pile,
 * not a list — the real count travels separately as `total`.
 */
const KNOWN_LIKERS_SAMPLE_LIMIT = 3;

/**
 * Ceiling on the `$in` width of the follow-graph filter. Oxy already bounds the
 * viewer graph server-side, so this is a second, local guard that keeps the
 * index scan bounded no matter what the upstream cap becomes — mirroring
 * `MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED`, the same bound the feed applies to a
 * viewer-derived id list.
 */
const MAX_KNOWN_LIKER_CANDIDATES = 5000;

/**
 * Social proof for a focused post: the people the VIEWER follows who liked it,
 * as a 3-avatar sample plus the exact total.
 *
 * Deliberately NOT a flag on `GET /:id/likes`. That one is a cursor-paginated
 * engagement list of everybody; this is a fixed-size sample intersected with the
 * viewer's follow graph, and returns the `{ items, total }` shape the profile's
 * "Followed by" row already consumes.
 *
 * The follow graph is Oxy-owned and the likes are Mention-owned, so the two are
 * intersected here. The graph comes from the CONSOLIDATED viewer-graph read
 * (`getViewerGraph`), not `getUserFollowing`: it answers the same question with
 * an ids-only, server-bounded payload instead of a hydrated user DTO per follow.
 *
 * Query shape is what keeps it cheap, and the shape that matters is `userId`
 * bounded by a `$in` PLUS an exact `postId`: together they let the unique
 * `{ userId: 1, postId: 1 }` index answer with one seek per followed id, so the
 * work scales with the viewer's FOLLOW COUNT — bounded below — instead of with
 * the post's like count. (The order of the keys in the filter document is
 * irrelevant; MongoDB's planner picks an index by cost, not by BSON order.)
 *
 * Measured on a 150k-like post with a 5000-wide graph and no matches, which is
 * both the common case and the one no `limit` can short-circuit: 5000 keys and
 * ZERO documents examined on the compound index, against 150,000 keys AND
 * 150,000 documents when forced onto `{ postId: 1 }` (9ms vs 105ms). The
 * planner reaches for the compound index unaided in every case where the
 * difference matters, so there is deliberately no `hint()` — that leaves it
 * free to use `{ postId: 1 }` when it is genuinely cheaper, e.g. an unpopular
 * post, or a match sitting at the front of the scan.
 *
 * Anonymous viewers have no follow graph and therefore no social proof to show,
 * so they get an empty result with a 200 — never a 401. This is a decorative
 * read on a public post-detail screen; failing it closed with an auth error
 * would make signed-out detail views log an error per post.
 */
export const getKnownPostLikers = async (req: AuthRequest, res: Response) => {
  try {
    // Narrowed with `String` because Express types a route param as
    // `string | string[]`; a repeated param collapses to a comma-joined string,
    // which fails the id check below exactly like any other malformed value.
    const id = String(req.params.id ?? '');
    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    const viewerId = req.user?.id;
    const oxyClient = createScopedOxyClient(req);
    if (!viewerId || !oxyClient) {
      return res.json({ likers: [], total: 0 });
    }

    const followingIds = extractFollowingIds(await oxyClient.getViewerGraph())
      .slice(0, MAX_KNOWN_LIKER_CANDIDATES);
    if (followingIds.length === 0) {
      return res.json({ likers: [], total: 0 });
    }

    const filter = and(
      inArray(likesTable.userId, followingIds),
      eq(likesTable.postId, id),
      eq(likesTable.value, 1),
    );

    // Unsorted on purpose: the unique `(user_id, post_id)` index answers this
    // with one seek per followed id, so any recency sort would add a blocking
    // sort over every match just to pick three avatars whose order carries no
    // meaning. `total` is exact.
    const db = getDb();
    const [likes, [totals]] = await Promise.all([
      db
        .select({ userId: likesTable.userId })
        .from(likesTable)
        .where(filter)
        .limit(KNOWN_LIKERS_SAMPLE_LIMIT),
      db.select({ total: sql<number>`count(*)::int` }).from(likesTable).where(filter),
    ]);

    const likerIds = [...new Set(likes.map((like) => like.userId))];
    const summaries = await resolveUserSummaries(likerIds);
    const likers = likerIds.map((likerId) => mapActorSummary(likerId, summaries.get(likerId)?.user));

    return res.json({ likers, total: totals?.total ?? 0 });
  } catch (error) {
    logger.error('Error fetching known post likers', error);
    return res.status(500).json({ message: 'Error fetching known post likers' });
  }
};

// Get users who boosted a post
export const getPostBoosts = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cursor = queryString(req.query.cursor);
    const limit = clampLikesLimit(queryInt(req.query.limit));

    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    // Chronological, matching the cursor it hands back. `_id DESC` used to be
    // both the order and the keyset, which agreed with each other while an
    // ObjectId encoded its creation time; with `posts.id` holding an ObjectId hex
    // for pre-cutover rows and a uuid v7 after, `id` order is neither
    // chronological nor stable across the boundary.
    const keyset = await chronoCursorSql(cursor);
    const conditions: SQL[] = [
      eq(postsTable.boostOf, String(id)),
      eq(postsTable.visibility, 'public'),
    ];
    if (keyset) conditions.push(keyset);

    const boosts = await getDb()
      .select({ id: postsTable.id, oxyUserId: postsTable.oxyUserId, createdAt: postsTable.createdAt })
      .from(postsTable)
      .where(and(...conditions))
      .orderBy(...chronoOrderBy())
      .limit(limit + 1);

    const hasMore = boosts.length > limit;
    const boostsToReturn = hasMore ? boosts.slice(0, limit) : boosts;
    const boostAnchor = hasMore ? boostsToReturn[limit - 1] : undefined;
    const nextCursor = boostAnchor
      ? ChronoCursor.build(boostAnchor.id, boostAnchor.createdAt)
      : undefined;

    // Get unique user IDs, then resolve actor summaries through the same shared
    // resolver PostHydrationService uses (canonical `name.displayName`, batched
    // bulk fetch, Redis-cached) instead of N hand-built per-id Oxy reads.
    const userIds = [...new Set(boostsToReturn.map(boost => boost.oxyUserId).filter((value): value is string => typeof value === 'string'))];
    const summaries = await resolveUserSummaries(userIds);
    const users = userIds.map((userId) => mapActorSummary(userId, summaries.get(userId)?.user));

    res.json({
      users,
      hasMore,
      nextCursor,
      totalCount: boostsToReturn.length
    });
  } catch (error) {
    logger.error('Error fetching post boosts', error);
    res.status(500).json({ message: 'Error fetching post boosts' });
  }
};
