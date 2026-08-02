/**
 * User-oriented source modules — the Hashtag, Author, and Saved feed queries
 * plus the `accounts` (custom-feed author list) source and `mutuals`.
 */

import { isAuthorFeedFilter, PostType, PostVisibility } from '@mention/shared-types';
import { and, arrayOverlaps, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../../../db/postgres';
import {
  bookmarks,
  likes,
  postAttachments,
  postContentVariants,
  postMedia,
  posts,
  userSettings,
} from '../../../../db/schema';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { assemblePostRecords } from '../../../../db/posts/postRepository';
import { ProfileVisibility, requiresAccessCheck } from '../../../../utils/privacyHelpers';
import { authorFeedSql } from '../../../../utils/postAuthorship';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../../CursorBuilder';
import { notABoostSql } from '../../../../utils/feedQueryBuilder';
import type { AuthorFeedFilter } from '@mention/shared-types';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/** Run a chronological post scan with the shared keyset + order. */
async function fetchChrono(
  conditions: SQL[],
  cursor: string | undefined,
  cap: number,
): Promise<CandidatePost[]> {
  const keyset = await chronoCursorSql(cursor);
  const where = keyset ? [...conditions, keyset] : conditions;

  const db = getDb();
  const rows = await db
    .select()
    .from(posts)
    .where(and(...where))
    .orderBy(...chronoOrderBy())
    .limit(cap);
  return assemblePostRecords(rows, db);
}

/** Escape a literal for embedding in a POSIX regular expression. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `keywords`: posts matching hashtags (Hashtag feed) and/or content keywords (custom). */
export const keywordsSource: SourceModule = {
  id: 'keywords',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const hashtags = Array.isArray(params.hashtags)
      ? (params.hashtags as string[]).map((t) => t.toLowerCase())
      : [];
    const keywords = Array.isArray(params.keywords) ? (params.keywords as string[]) : [];

    if (hashtags.length === 0 && keywords.length === 0) return [];

    const conditions: SQL[] = [eq(posts.visibility, 'public'), eq(posts.status, 'published')];
    const alternatives: SQL[] = [];

    if (keywords.length > 0) {
      // One alternation matching any keyword, rather than N separate EXISTS
      // scans over the same child table. `~*` is the case-insensitive POSIX
      // regex — the direct analogue of the JS `RegExp(..., 'i')` this replaces.
      const pattern = keywords.map(escapeRegexLiteral).join('|');
      alternatives.push(
        sql`exists ${getDb()
          .select({ one: sql`1` })
          .from(postContentVariants)
          .where(
            and(
              eq(postContentVariants.postId, posts.id),
              sql`${postContentVariants.body} ~* ${pattern}`,
            ),
          )}`,
      );
      // `arrayOverlaps`, never a raw `${array}::text[]`: a JS array interpolated
      // into a `sql` template binds as a ROW CONSTRUCTOR (`($1, $2)`), which
      // Postgres refuses to cast to `text[]` — so the whole query THROWS at
      // runtime rather than matching nothing. `coalesce(…, false)` stays because
      // `hashtags` is nullable and `NULL && ARRAY[…]` is NULL.
      alternatives.push(
        sql`coalesce(${arrayOverlaps(posts.hashtags, keywords.map((k) => k.toLowerCase()))}, false)`,
      );
    }

    if (hashtags.length > 0) {
      alternatives.push(sql`coalesce(${arrayOverlaps(posts.hashtags, hashtags)}, false)`);
    }

    conditions.push(or(...alternatives) as SQL);

    return fetchChrono(conditions, ctx.cursor, cap);
  },
};

/** `accounts`: posts from an explicit author-id list (custom feeds). */
export const accountsSource: SourceModule = {
  id: 'accounts',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const authorIds = Array.isArray(params.authorIds) ? (params.authorIds as string[]) : [];
    if (authorIds.length === 0) return [];

    return fetchChrono(
      [
        inArray(posts.oxyUserId, authorIds),
        eq(posts.visibility, 'public'),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/** "This post carries media", in the three shapes `mediaOnlyFilter.keep` recognizes. */
function hasMediaSql(): SQL {
  const db = getDb();
  return or(
    inArray(posts.type, [PostType.IMAGE, PostType.VIDEO]),
    sql`exists ${db.select({ one: sql`1` }).from(postMedia).where(eq(postMedia.postId, posts.id))}`,
    sql`exists ${db
      .select({ one: sql`1` })
      .from(postAttachments)
      .where(and(eq(postAttachments.postId, posts.id), eq(postAttachments.type, 'media')))}`,
  ) as SQL;
}

/** Author query: posts owned by or accepted-collaborated by the profile user. */
function buildAuthoredConditions(authorId: string, filter: AuthorFeedFilter): SQL[] {
  const conditions: SQL[] = [
    authorFeedSql(authorId),
    eq(posts.visibility, PostVisibility.PUBLIC),
    eq(posts.status, 'published'),
  ];

  switch (filter) {
    case 'posts':
      // Boosts are top-level posts, so they surface on the main tab too — the
      // definition hydrates at depth 1 so the boosted original renders.
      conditions.push(eq(posts.isReply, false));
      break;
    case 'replies':
      conditions.push(eq(posts.isReply, true));
      break;
    case 'boosts':
      conditions.push(sql`${posts.boostOf} is not null`);
      break;
    case 'media':
      conditions.push(hasMediaSql(), eq(posts.isReply, false), notABoostSql());
      break;
    case 'likes':
      break;
  }

  return conditions;
}

/**
 * Whether the viewer may see the profile's feed at all.
 *
 * A private / followers-only profile is gated on the viewer following it — the
 * same check the profile screen enforces, applied here so it holds for EVERY tab
 * (posts, replies, media, boosts, likes) rather than the posts themselves
 * leaking through their own `visibility: public` flag. Returning `false` yields
 * an empty feed, which is exactly what a viewer without access must see.
 */
async function canViewAuthorFeed(ctx: FeedEngineContext, authorId: string): Promise<boolean> {
  if (ctx.currentUserId === authorId) return true;
  const [settings] = await getDb()
    .select({ profileVisibility: userSettings.privacyProfileVisibility })
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, authorId))
    .limit(1);
  const profileVisibility = settings?.profileVisibility ?? ProfileVisibility.PUBLIC;
  if (!requiresAccessCheck(profileVisibility)) return true;
  if (!ctx.currentUserId) return false;
  return (ctx.followingIds ?? []).includes(authorId);
}

/** Which liked posts the viewer is allowed to see, by post visibility. */
function buildVisibleLikedPostSql(ctx: FeedEngineContext): SQL {
  const viewerId = ctx.currentUserId;
  if (!viewerId) return eq(posts.visibility, PostVisibility.PUBLIC);

  const followAuthorizedIds = Array.from(
    new Set([viewerId, ...(ctx.followingIds ?? [])].filter(Boolean)),
  );

  return or(
    eq(posts.visibility, PostVisibility.PUBLIC),
    and(
      inArray(posts.oxyUserId, followAuthorizedIds),
      eq(posts.visibility, PostVisibility.FOLLOWERS_ONLY),
    ),
    and(eq(posts.oxyUserId, viewerId), eq(posts.visibility, PostVisibility.PRIVATE)),
  ) as SQL;
}

/**
 * Keyset over a RELATIONSHIP table (likes, bookmarks) whose own
 * `(created_at, id)` is the feed's order.
 *
 * These sources page over the relationship, not the post, so their cursor
 * anchors a `likes`/`bookmarks` row. The Mongo original filtered `_id < cursor`
 * while SORTING by `createdAt` — two different axes, which only appeared to work
 * because an ObjectId encodes creation time. Neither half survives here (`id` is
 * `text`, see `chronoOrderBy`), so the port pages on the axis it actually sorts
 * by.
 */
function relationshipKeyset(
  createdAtColumn: PgColumn,
  idColumn: PgColumn,
  cursor: string | undefined,
): SQL | undefined {
  const parsed = ChronoCursor.parse(cursor);
  if (!parsed?.ts) return undefined;
  const boundaryAt = new Date(parsed.ts);
  return or(
    lt(createdAtColumn, boundaryAt),
    and(eq(createdAtColumn, boundaryAt), lt(idColumn, parsed.id)),
  ) as SQL;
}

/**
 * The descending order {@link relationshipKeyset} pages against — written so an
 * index can actually serve it.
 *
 * `nulls last` for the same reason `chronoOrderBy` spells it out: both columns
 * are NOT NULL so it changes no row, but drizzle emits `.desc()` in index DDL as
 * `DESC NULLS LAST` while a query's `desc()` means `DESC NULLS FIRST`, and
 * Postgres compares the NULLS placement when deciding whether an index can
 * satisfy an ORDER BY. `likes_user_id_created_at_idx` and
 * `bookmarks_user_id_created_at_idx` are both `(user_id, created_at DESC NULLS
 * LAST)`, and both queries below are a per-viewer keyset over them.
 *
 * Measured, 20,000 rows for one viewer, page of 31:
 *
 *   likes      Seq Scan + Sort, cost 1092.42  →  Index Scan, cost 4.31
 *   bookmarks  Seq Scan + Sort, cost 1073.42  →  Index Scan, cost 4.24
 *
 * Neither index carries `id`, so the good plan is an Incremental Sort with
 * `created_at` presorted — it streams and only ever sorts one tie group, and the
 * LIMIT stops it after 32 rows instead of reading the viewer's whole history.
 */
function relationshipOrder(createdAtColumn: PgColumn, idColumn: PgColumn): SQL[] {
  return [sql`${createdAtColumn} desc nulls last`, sql`${idColumn} desc nulls last`];
}

/** The viewer's liked posts, in like order, for the ORDERED Author-likes feed. */
async function gatherAuthorLikes(authorId: string, ctx: FeedEngineContext): Promise<CandidatePost[]> {
  const pageLimit = ctx.pageLimit ?? 30;
  const db = getDb();

  const keyset = relationshipKeyset(likes.createdAt, likes.id, ctx.cursor);
  const likeRows = await db
    .select({ id: likes.id, postId: likes.postId, createdAt: likes.createdAt })
    .from(likes)
    .where(
      and(
        ...[eq(likes.userId, authorId), eq(likes.value, 1), ...(keyset ? [keyset] : [])],
      ),
    )
    .orderBy(...relationshipOrder(likes.createdAt, likes.id))
    .limit(pageLimit + 1);

  if (likeRows.length === 0) return [];

  const hasMore = likeRows.length > pageLimit;
  const page = hasMore ? likeRows.slice(0, pageLimit) : likeRows;
  const likedPostIds = page.map((row) => row.postId);

  const rows = await db
    .select()
    .from(posts)
    .where(
      and(
        inArray(posts.id, likedPostIds),
        eq(posts.status, 'published'),
        buildVisibleLikedPostSql(ctx),
      ),
    );
  const loaded: CandidatePost[] = await assemblePostRecords(rows, db);

  const postMap = new Map(loaded.map((post) => [post.id, post]));
  const ordered = likedPostIds
    .map((id) => postMap.get(id))
    .filter((post): post is CandidatePost => Boolean(post));

  if (hasMore && ordered.length > 0) {
    const anchor = page[page.length - 1];
    ordered[ordered.length - 1]._feedCursor = ChronoCursor.build(anchor.id, anchor.createdAt);
  }
  return ordered;
}

/**
 * `authored`: a single author's posts/replies/media/boosts (chronological) or
 * likes (ordered) — the profile feed. Params `{ authorId, filter }`.
 */
export const authoredSource: SourceModule = {
  id: 'authored',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, params, cap) => {
    const authorId = typeof params.authorId === 'string' ? params.authorId : '';
    if (!authorId) return [];
    const filterParam = typeof params.filter === 'string' ? params.filter : undefined;
    const filter: AuthorFeedFilter = isAuthorFeedFilter(filterParam) ? filterParam : 'posts';

    if (!(await canViewAuthorFeed(ctx, authorId))) return [];

    if (filter === 'likes') {
      return gatherAuthorLikes(authorId, ctx);
    }

    // Sorted by `created_at` — never by id — to match the chronological keyset.
    // A federated post's import-time id bears no relation to its remote
    // `createdAt`, so an id sort behind a `createdAt` cursor permanently skips
    // backfilled posts at the page boundary (the "boost disappears from the
    // profile feed" bug).
    return fetchChrono(buildAuthoredConditions(authorId, filter), ctx.cursor, cap);
  },
};

/** `saved`: the viewer's bookmarks in bookmark order (ORDERED). */
export const savedSource: SourceModule = {
  id: 'saved',
  kind: 'source',
  userComposable: false,
  gather: async (ctx) => {
    if (!ctx.currentUserId) return [];
    const pageLimit = ctx.pageLimit ?? 30;
    const db = getDb();

    const keyset = relationshipKeyset(bookmarks.createdAt, bookmarks.id, ctx.cursor);
    const bookmarkRows = await db
      .select({ id: bookmarks.id, postId: bookmarks.postId, createdAt: bookmarks.createdAt })
      .from(bookmarks)
      .where(and(...[eq(bookmarks.userId, ctx.currentUserId), ...(keyset ? [keyset] : [])]))
      .orderBy(...relationshipOrder(bookmarks.createdAt, bookmarks.id))
      .limit(pageLimit + 1);

    if (bookmarkRows.length === 0) return [];

    const hasMore = bookmarkRows.length > pageLimit;
    const page = hasMore ? bookmarkRows.slice(0, pageLimit) : bookmarkRows;
    const postIds = page.map((row) => row.postId);

    const rows = await db
      .select()
      .from(posts)
      .where(and(inArray(posts.id, postIds), eq(posts.status, 'published')));
    const loaded: CandidatePost[] = await assemblePostRecords(rows, db);

    const postMap = new Map(loaded.map((post) => [post.id, post]));
    const ordered = postIds
      .map((id) => postMap.get(id))
      .filter((post): post is CandidatePost => Boolean(post));

    if (hasMore && ordered.length > 0) {
      const anchor = page[page.length - 1];
      ordered[ordered.length - 1]._feedCursor = ChronoCursor.build(anchor.id, anchor.createdAt);
    }
    return ordered;
  },
};

/**
 * `mutuals`: the viewer's mutual-follow authors, chronological. `ctx.mutualIds`
 * is populated by the controller only for the Mutuals feed; returns `[]` when it
 * is empty. Mutuals may show PUBLIC + FOLLOWERS_ONLY posts (a mutual is, by
 * definition, a follower).
 */
export const mutualsSource: SourceModule = {
  id: 'mutuals',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const mutualIds = ctx.mutualIds ?? [];
    if (mutualIds.length === 0) return [];

    return fetchChrono(
      [
        inArray(posts.oxyUserId, mutualIds),
        inArray(posts.visibility, [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY]),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

export const userSourceModules: SourceModule[] = [
  keywordsSource,
  accountsSource,
  authoredSource,
  savedSource,
  mutualsSource,
];
