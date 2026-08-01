/**
 * Social-graph + content source modules.
 *
 * Each is a {@link SourceModule} producing a bounded candidate set derived from
 * the viewer's follow / engagement graph or from content classification. They
 * follow one authoring pattern: a single query selecting the candidate column
 * set, `(created_at DESC, id DESC)` + `chronoCursorSql` for timeline sources,
 * capped to `cap`, and soft-failing to `[]`. No ranking or hydration logic lives
 * here — the engine wraps them.
 */

import { PostType, PostVisibility, MtnConfig } from '@mention/shared-types';
import {
  and,
  arrayOverlaps,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { getDb } from '../../../../db/postgres';
import {
  entityFollows,
  likes,
  postContentVariants,
  postMentions,
  postSources,
  posts,
  starterPackMembers,
} from '../../../../db/schema';
import { assemblePostRecords } from '../../../../db/posts/postRepository';
import { chronoCursorSql, chronoOrderBy } from '../../CursorBuilder';
import { discoverySafeSql } from '../../feedSafety';
import { logger } from '../../../../utils/logger';
import { notABoostSql, rankingWeight } from '../../../../utils/feedQueryBuilder';
import type { CandidatePost, SourceModule } from '../types';

/**
 * A "new voice" author must have at most this many recent posts to qualify as
 * low-volume in the local approximation. True account-age / follower-count
 * gating requires Oxy user data and is out of scope here.
 */
const NEW_VOICE_MAX_RECENT_POSTS = 20;

/** Chronological fetch shared by the timeline-style social sources. */
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

/** Fetch posts by id, preserving the given id order (used by the pre-ranked sources). */
async function fetchPostsByIds(ids: string[]): Promise<CandidatePost[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(posts)
    .where(inArray(posts.id, ids));
  const loaded: CandidatePost[] = await assemblePostRecords(rows, db);
  const order = new Map(ids.map((id, i) => [id, i]));
  return loaded.sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

/**
 * The UNSPLIT engagement composite — likes + ALL boosts + comments, with no
 * native/federated distinction.
 *
 * ## This DIVERGES from `engagementScoreSql`, and the divergence is PRESERVED
 *
 * `discoverySources.engagementScoreSql` splits the boost term: the native subset
 * (`boosts − federatedBoosts`) is weighted at `boostWeight` (2.5) and the
 * federated subset at `federatedBoostWeight` (0.5), because — per the config's
 * own comment — "a handful of federated boosts routinely made low-quality
 * off-instance posts look trending". This one weights every boost at 2.5.
 *
 * In Mongo these were two same-named functions in two files, one exported and
 * one private, and nothing indicated they disagreed. The port keeps the
 * BEHAVIOUR and removes the disguise: two differently-named expressions, each
 * stating what it is, with `socialEngagementScoreSql.test.ts` asserting they
 * produce DIFFERENT scores for a post carrying federated boosts. That test is
 * the tripwire — the divergence can no longer be spread by copy-paste or
 * "unified" by accident, in either direction.
 *
 * WHY NOT RECONCILE, given `topReplies` is a discovery surface and this looks
 * like drift rather than intent: unifying changes the ORDER `topReplies`
 * returns. A store migration whose contract is "the wire format must not change"
 * is the wrong place to re-tune ranking — the change would ship inside a
 * hundred-file diff with no way to attribute a ranking regression to it. It is
 * a one-line change once someone owns the ranking question; the test names this
 * function so that person finds it.
 *
 * Only `topRepliesSource` uses it.
 */
export function socialEngagementScoreSql(): SQL<number> {
  const cfg = MtnConfig.ranking.engagement;
  return sql<number>`(
    ${posts.statsLikesCount} * ${rankingWeight(cfg.likeWeight)}
    + ${posts.statsBoostsCount} * ${rankingWeight(cfg.boostWeight)}
    + ${posts.statsCommentsCount} * ${rankingWeight(cfg.commentWeight)}
  )::double precision`;
}

/**
 * `friendsEngaged`: posts the viewer's follows liked or boosted in the recent
 * window, ranked by how many follows engaged with each ("Popular with Friends").
 * Pre-orders by friend-engagement count (stamped as `finalScore`) so the ranked
 * definition sees the most-engaged candidates; the engine re-ranks with its
 * engagement/recency signals. Excludes the viewer's own posts and boosts.
 */
export const friendsEngagedSource: SourceModule = {
  id: 'friendsEngaged',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const followingIds = ctx.followingIds ?? [];
    if (followingIds.length === 0) return [];

    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);
    const db = getDb();

    // GROUP BY on the likes table — the direct port of the `$group` pipeline.
    const likeGroups = await db
      .select({ postId: likes.postId, friendCount: sql<number>`count(*)::int` })
      .from(likes)
      .where(
        and(
          inArray(likes.userId, followingIds),
          eq(likes.value, 1),
          gte(likes.createdAt, windowStart),
        ),
      )
      .groupBy(likes.postId)
      .orderBy(desc(sql`count(*)`))
      .limit(cap);

    const boostDocs = await db
      .select({ boostOf: posts.boostOf })
      .from(posts)
      .where(
        and(
          eq(posts.type, PostType.BOOST),
          inArray(posts.oxyUserId, followingIds),
          gte(posts.createdAt, windowStart),
          isNotNull(posts.boostOf),
        ),
      )
      .limit(cap);

    const friendCountByPost = new Map<string, number>();
    for (const group of likeGroups) {
      if (group.postId) {
        friendCountByPost.set(
          group.postId,
          (friendCountByPost.get(group.postId) ?? 0) + group.friendCount,
        );
      }
    }
    for (const boost of boostDocs) {
      if (boost.boostOf) {
        friendCountByPost.set(boost.boostOf, (friendCountByPost.get(boost.boostOf) ?? 0) + 1);
      }
    }
    if (friendCountByPost.size === 0) return [];

    const conditions: SQL[] = [
      inArray(posts.id, Array.from(friendCountByPost.keys())),
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
      notABoostSql(),
    ];
    if (ctx.currentUserId) {
      // Nullable author column: `<>` alone is NULL-propagating and would drop
      // every author-less post. See `authorNotInSql` for the full explanation.
      conditions.push(
        or(isNull(posts.oxyUserId), sql`${posts.oxyUserId} <> ${ctx.currentUserId}`) as SQL,
      );
    }

    const rows = await db.select().from(posts).where(and(...conditions));
    const candidates: CandidatePost[] = await assemblePostRecords(rows, db);

    return candidates
      .map((post) => {
        post.finalScore = friendCountByPost.get(post.id) ?? 0;
        return post;
      })
      .sort((a, b) => {
        const diff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
        if (diff !== 0) return diff;
        const at = new Date((a.createdAt as Date | string | undefined) ?? 0).getTime();
        const bt = new Date((b.createdAt as Date | string | undefined) ?? 0).getTime();
        return bt - at;
      })
      .slice(0, cap);
  },
};

/**
 * `quotes`: quote posts referencing a specific post (`params.postId`) and/or
 * authored by a set of authors (`params.authorIds`). Chronological.
 */
export const quotesSource: SourceModule = {
  id: 'quotes',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const postId = typeof params.postId === 'string' ? params.postId : '';
    const authorIds = Array.isArray(params.authorIds) ? (params.authorIds as string[]) : [];
    if (!postId && authorIds.length === 0) return [];

    const alternatives: SQL[] = [];
    if (postId) alternatives.push(eq(posts.quoteOf, postId));
    if (authorIds.length > 0) {
      alternatives.push(and(isNotNull(posts.quoteOf), inArray(posts.oxyUserId, authorIds)) as SQL);
    }

    return fetchChrono(
      [
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
        or(...alternatives) as SQL,
      ],
      ctx.cursor,
      cap,
    );
  },
};

/** `repliesFromFollows`: replies authored by the viewer's follows (conversation). */
export const repliesFromFollowsSource: SourceModule = {
  id: 'repliesFromFollows',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const followingIds = ctx.followingIds ?? [];
    if (followingIds.length === 0) return [];

    return fetchChrono(
      [
        inArray(posts.oxyUserId, followingIds),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
        eq(posts.isReply, true),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `boostsFromFollows`: boost (repost) posts authored by the viewer's follows.
 * Boosts carry an intentionally empty body — any definition using this source
 * MUST hydrate at `maxDepth:1` (see the boost-hydration gotcha) or they render
 * blank.
 */
export const boostsFromFollowsSource: SourceModule = {
  id: 'boostsFromFollows',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const followingIds = ctx.followingIds ?? [];
    if (followingIds.length === 0) return [];

    return fetchChrono(
      [
        eq(posts.type, PostType.BOOST),
        inArray(posts.oxyUserId, followingIds),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/** `mentionsOfMe`: posts whose mention set contains the viewer. */
export const mentionsOfMeSource: SourceModule = {
  id: 'mentionsOfMe',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const viewerId = ctx.currentUserId;
    if (!viewerId) return [];

    // `mentions` became a junction table, so Mongo's `{ mentions: viewerId }`
    // array-element match becomes a correlated EXISTS. Built through the query
    // builder so `post_mentions.post_id = posts.id` renders qualified.
    const mentioned = sql`exists ${getDb()
      .select({ one: sql`1` })
      .from(postMentions)
      .where(and(eq(postMentions.postId, posts.id), eq(postMentions.oxyUserId, viewerId)))}`;

    return fetchChrono(
      [
        mentioned,
        inArray(posts.visibility, [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY]),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `hashtagFollows`: posts carrying any hashtag the viewer follows (resolved via
 * `entity_follows` `entityType:'hashtag'`).
 *
 * The stored ids go into the query AS-IS. `POST /entity-follows` canonicalizes a
 * followed tag with `normalizeHashtag` — the same function that derives
 * `posts.hashtags` — so the two are the same string by construction. Normalizing
 * again here would be a second rule free to drift from that one.
 */
export const hashtagFollowsSource: SourceModule = {
  id: 'hashtagFollows',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    if (!ctx.currentUserId) return [];

    let tags: string[] = [];
    try {
      const rows = await getDb()
        .selectDistinct({ entityId: entityFollows.entityId })
        .from(entityFollows)
        .where(
          and(
            eq(entityFollows.userId, ctx.currentUserId),
            eq(entityFollows.entityType, 'hashtag'),
          ),
        );
      tags = rows.map((row) => row.entityId);
    } catch (error) {
      logger.warn('[hashtagFollows source] Failed to load followed hashtags', error);
      return [];
    }

    if (tags.length === 0) return [];

    return fetchChrono(
      [
        // Array OVERLAP — the analogue of Mongo's `$in` against a multikey field.
        //
        // Through `arrayOverlaps`, never a raw `${tags}::text[]`: a JS array
        // interpolated into a `sql` template binds as a ROW CONSTRUCTOR
        // (`($1, $2)`), which Postgres refuses to cast to `text[]`, so the query
        // THROWS rather than matching nothing. `coalesce(…, false)` stays
        // because `hashtags` is nullable and `NULL && ARRAY[…]` is NULL.
        sql`coalesce(${arrayOverlaps(posts.hashtags, tags)}, false)`,
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/** `starterPack`: posts by the members of a StarterPack (`params.packId`). */
export const starterPackSource: SourceModule = {
  id: 'starterPack',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const packId = typeof params.packId === 'string' ? params.packId : '';
    if (!packId) return [];

    // Members are a junction TABLE here, not the embedded id array Mongo held —
    // `CONVENTIONS.md` makes an array of ids a real table so it can be joined,
    // constrained and indexed. So this is a member query, not a pack lookup:
    // reading the pack row would return no members at all.
    let memberIds: string[] = [];
    try {
      const rows = await getDb()
        .select({ oxyUserId: starterPackMembers.oxyUserId })
        .from(starterPackMembers)
        .where(eq(starterPackMembers.packId, packId))
        .orderBy(starterPackMembers.position);
      memberIds = rows.map((row) => row.oxyUserId);
    } catch (error) {
      logger.warn('[starterPack source] Failed to load starter pack', { packId, error });
      return [];
    }
    if (memberIds.length === 0) return [];

    return fetchChrono(
      [
        inArray(posts.oxyUserId, memberIds),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `onThisDay`: nostalgia — the viewer's own posts (or the viewer + their follows
 * when `params.scope === 'follows'`) from earlier years on today's month/day.
 *
 * `extract(... from created_at)` is the port of Mongo's `$month`/`$dayOfMonth`
 * `$expr`. Both stores evaluate it per row, so it is bounded by the author-id
 * filter exactly as before — the timestamps are `timestamptz`, so the extraction
 * runs in the session time zone; `at time zone 'utc'` pins it to the same UTC
 * calendar day Mongo's operators used, which is also what the JS side computes
 * with `getUTCMonth`/`getUTCDate`.
 */
export const onThisDaySource: SourceModule = {
  id: 'onThisDay',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, params, cap) => {
    if (!ctx.currentUserId) return [];

    const scope = params.scope === 'follows' ? 'follows' : 'self';
    const authorIds =
      scope === 'follows'
        ? Array.from(new Set([ctx.currentUserId, ...(ctx.followingIds ?? [])]))
        : [ctx.currentUserId];

    const now = new Date();
    const utc = sql`(${posts.createdAt} at time zone 'utc')`;

    return fetchChrono(
      [
        inArray(posts.oxyUserId, authorIds),
        eq(posts.status, 'published'),
        sql`extract(month from ${utc}) = ${now.getUTCMonth() + 1}`,
        sql`extract(day from ${utc}) = ${now.getUTCDate()}`,
        sql`extract(year from ${utc}) < ${now.getUTCFullYear()}`,
      ],
      ctx.cursor,
      cap,
    );
  },
};

/** `questions`: posts classified with `intent === 'question'` (Q&A discovery). */
export const questionsSource: SourceModule = {
  id: 'questions',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) =>
    fetchChrono(
      [
        eq(posts.classificationIntent, 'question'),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    ),
};

/** `news`: posts classified with `intent === 'news'` or a `news` topic. */
export const newsSource: SourceModule = {
  id: 'news',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) =>
    fetchChrono(
      [
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
        or(
          eq(posts.classificationIntent, 'news'),
          sql`coalesce(${posts.classificationTopics} @> array['news']::text[], false)`,
        ) as SQL,
      ],
      ctx.cursor,
      cap,
    ),
};

/**
 * `instance`: posts from a specific fediverse instance (`params.domain`), or
 * local-only posts when `params.domain === 'local'`.
 *
 * DATA-MODEL GAP (carried over): there is no denormalized instance-domain
 * column, only `federation_actor_uri`, so remote matching is an anchored
 * host-prefix match — correct but not index-served. The fix is to persist and
 * index the domain at ingest.
 *
 * `local` keys off `federation_actor_uri IS NULL`. In Mongo the whole
 * `federation` subdocument was absent for a local post; here the columns are
 * individually null, and the actor URI is the one every federated ingest path
 * writes.
 */
export const instanceSource: SourceModule = {
  id: 'instance',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const domain = typeof params.domain === 'string' ? params.domain.trim().toLowerCase() : '';
    if (!domain) return [];

    const conditions: SQL[] = [
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
    ];

    if (domain === 'local') {
      conditions.push(isNull(posts.federationActorUri));
    } else {
      // `~*` is a case-insensitive POSIX regex, the direct analogue of the
      // JavaScript `RegExp(..., 'i')` this replaces. The pattern is anchored so
      // `evil-example.com` cannot match a request for `example.com`.
      const pattern = `^https?://${escapeRegexLiteral(domain)}(:[0-9]+)?/`;
      conditions.push(sql`${posts.federationActorUri} ~* ${pattern}`);
    }

    return fetchChrono(conditions, ctx.cursor, cap);
  },
};

/** Escape a literal for embedding in a POSIX regular expression. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `links`: posts linking to a specific domain (`params.domain`) — "news from
 * domain X".
 *
 * DATA-MODEL GAP (carried over): there is no persisted link-host column, so this
 * scans the cited `post_sources.url` and the inline body of every content
 * variant with a host-boundary regex — correct but not index-served. The fix is
 * to persist and index a normalized link-host set at ingest.
 */
export const linksSource: SourceModule = {
  id: 'links',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const domain = typeof params.domain === 'string' ? params.domain.trim().toLowerCase() : '';
    if (!domain) return [];

    const pattern = `https?://([a-z0-9-]+\\.)*${escapeRegexLiteral(domain)}([/:?#]|\\s|$)`;
    const db = getDb();

    const inSources = sql`exists ${db
      .select({ one: sql`1` })
      .from(postSources)
      .where(and(eq(postSources.postId, posts.id), sql`${postSources.url} ~* ${pattern}`))}`;

    const inBody = sql`exists ${db
      .select({ one: sql`1` })
      .from(postContentVariants)
      .where(
        and(eq(postContentVariants.postId, posts.id), sql`${postContentVariants.body} ~* ${pattern}`),
      )}`;

    return fetchChrono(
      [
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
        or(inSources, inBody) as SQL,
      ],
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `newVoices`: cold-start discovery of accounts new to the network.
 *
 * DATA-MODEL GAP (carried over): true "new account" detection (creation age +
 * follower count) requires Oxy user data. This local approximation surfaces
 * LOW-VOLUME authors active in the recency window, earliest-arriving first, and
 * fetches each qualifying author's latest post. Always SFW.
 *
 * `max(id)` picked the latest post in Mongo because an ObjectId encodes its
 * creation time. It does not here (see `chronoOrderBy`), so "latest" is resolved
 * with `DISTINCT ON` over the real `(created_at DESC, id DESC)` order — which is
 * also strictly more correct for federated posts, whose import-time id bears no
 * relation to when they were written.
 */
export const newVoicesSource: SourceModule = {
  id: 'newVoices',
  kind: 'source',
  userComposable: true,
  gather: async (_ctx, _params, cap) => {
    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);
    const db = getDb();

    const groups = await db
      .select({
        oxyUserId: posts.oxyUserId,
        latestPostId: sql<string>`(array_agg(${posts.id} order by ${posts.createdAt} desc, ${posts.id} desc))[1]`,
        recentCount: sql<number>`count(*)::int`,
        firstPostAt: sql<Date>`min(${posts.createdAt})`,
      })
      .from(posts)
      .where(
        and(
          eq(posts.visibility, PostVisibility.PUBLIC),
          eq(posts.status, 'published'),
          gte(posts.createdAt, windowStart),
          discoverySafeSql(),
          eq(posts.isReply, false),
          notABoostSql(),
          isNotNull(posts.oxyUserId),
        ),
      )
      .groupBy(posts.oxyUserId)
      .having(sql`count(*) <= ${NEW_VOICE_MAX_RECENT_POSTS}`)
      .orderBy(desc(sql`min(${posts.createdAt})`))
      .limit(cap);

    return fetchPostsByIds(groups.map((group) => group.latestPostId).filter(Boolean));
  },
};

/**
 * `topReplies`: the highest-engagement replies in the recency window ("best
 * replies"). Ranks with the composite, then fetches the ranked posts preserving
 * that order. Always SFW.
 *
 * Uses {@link socialEngagementScoreSql} — the UNSPLIT composite. That is a
 * deliberate divergence from the discovery lanes; see its doc.
 */
export const topRepliesSource: SourceModule = {
  id: 'topReplies',
  kind: 'source',
  userComposable: true,
  gather: async (_ctx, _params, cap) => {
    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);
    const engagementScore = socialEngagementScoreSql();

    const ranked = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.visibility, PostVisibility.PUBLIC),
          eq(posts.status, 'published'),
          gte(posts.createdAt, windowStart),
          discoverySafeSql(),
          eq(posts.isReply, true),
        ),
      )
      .orderBy(desc(engagementScore), desc(posts.id))
      .limit(cap);

    return fetchPostsByIds(ranked.map((row) => row.id));
  },
};

/**
 * `friendsOfFriends`: posts by accounts the viewer's follows follow (but the
 * viewer does not) — social-graph expansion. `ctx.fofIds` is populated by the
 * controller ONLY for the Friends-of-Friends feed; returns `[]` when it is empty.
 * PUBLIC-only — FoF authors are NOT the viewer's followers, so followers-only
 * posts are excluded.
 */
export const friendsOfFriendsSource: SourceModule = {
  id: 'friendsOfFriends',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const fofIds = ctx.fofIds ?? [];
    if (fofIds.length === 0) return [];

    return fetchChrono(
      [
        inArray(posts.oxyUserId, fofIds),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `curated`: editorially-promoted posts (`curated = true`). The column is
 * nullable with a partial index (only curated posts carry it), so this is an
 * equality test rather than a truthiness one.
 */
export const curatedSource: SourceModule = {
  id: 'curated',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) =>
    fetchChrono(
      [
        eq(posts.curated, true),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    ),
};

export const socialSourceModules: SourceModule[] = [
  friendsEngagedSource,
  quotesSource,
  repliesFromFollowsSource,
  boostsFromFollowsSource,
  mentionsOfMeSource,
  hashtagFollowsSource,
  starterPackSource,
  onThisDaySource,
  questionsSource,
  newsSource,
  instanceSource,
  linksSource,
  newVoicesSource,
  topRepliesSource,
  friendsOfFriendsSource,
  curatedSource,
];
