import { logger } from '../utils/logger';
import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { MtnConfig, type FeedPostSlice } from '@mention/shared-types';
import { getDb } from '../db/postgres';
import { likes, posts, userSettings } from '../db/schema';
import type { FeedEngineContext } from '../mtn/feed/engine/types';
import { resolveUserSummaries } from './PostHydrationService';

export const MAX_SOCIAL_ACTORS = 500;
export const MAX_SOCIAL_POSTS = 200;

/** Likes are private by default. A missing settings row never grants consent. */
export function publicPositiveLikeSql(): SQL {
  return and(
    eq(likes.value, 1),
    sql`exists (select 1 from ${userSettings} where ${userSettings.oxyUserId} = ${likes.userId} and ${userSettings.privacyShowLikes} = true)`,
  ) as SQL;
}

export function eligibleSocialActors(ctx: FeedEngineContext): string[] {
  const excluded = new Set([
    ctx.currentUserId,
    ...(ctx.excludedAuthorIds ?? []),
    ...(ctx.viewerPrivacy?.blockedIds ?? []),
    ...(ctx.viewerPrivacy?.restrictedIds ?? []),
    ...(ctx.userBehavior?.hiddenAuthors ?? []),
    ...(ctx.userBehavior?.mutedAuthors ?? []),
    ...(ctx.userBehavior?.blockedAuthors ?? []),
  ]);
  return [...new Set(ctx.followingIds ?? [])]
    .filter((id) => !excluded.has(id))
    .sort()
    .slice(0, MAX_SOCIAL_ACTORS);
}

/** Both candidate discovery and evidence use the same public, positive facts. */
export function networkEngagementExistsSql(actorIds: string[], since: Date, asOf: Date): SQL {
  if (!actorIds.length) return sql`false`;
  return sql`${posts.id} in (
    select ${likes.postId} from ${likes}
      where ${inArray(likes.userId, actorIds)} and ${publicPositiveLikeSql()}
      and ${likes.createdAt} >= ${since.toISOString()} and ${likes.createdAt} <= ${asOf.toISOString()}
    union
    select social_boost.boost_of from posts social_boost
      where social_boost.oxy_user_id = any(${sql.param(actorIds)}::text[])
      and social_boost.type = 'boost' and social_boost.status = 'published'
      and social_boost.visibility = 'public' and social_boost.boost_of is not null
      and social_boost.created_at >= ${since.toISOString()} and social_boost.created_at <= ${asOf.toISOString()}
  )`;
}

/** Revalidate deferred social-only candidates without reading any actor identities. */
export async function eligibleSocialPostIds(
  postIds: string[],
  ctx: FeedEngineContext,
): Promise<Set<string>> {
  const actors = eligibleSocialActors(ctx);
  if (!actors.length || !postIds.length) return new Set();
  const asOf = new Date(ctx.rankingAsOf ?? Date.now());
  const since = new Date(asOf.getTime() - MtnConfig.feed.candidateSources.recencyWindowMs);
  const rows = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        inArray(posts.id, postIds),
        eq(posts.status, 'published'),
        eq(posts.visibility, 'public'),
        networkEngagementExistsSql(actors, since, asOf),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** At most two bounded evidence reads after hydration, then one batched identity lookup. */
async function attachCurrentSocialFeedContext(
  slices: FeedPostSlice[],
  ctx: FeedEngineContext,
): Promise<void> {
  const actorIds = eligibleSocialActors(ctx);
  if (!actorIds.length || !slices.length) return;
  const targets = slices.map(
    (slice) =>
      (slice.reason?.type === 'replyContext' ? slice.items.at(-1) : slice.items[0])?.post.id,
  );
  const postIds = [...new Set(targets.filter((id): id is string => Boolean(id)))].slice(
    0,
    MAX_SOCIAL_POSTS,
  );
  if (!postIds.length) return;
  const asOf = new Date(ctx.rankingAsOf ?? Date.now());
  const since = new Date(asOf.getTime() - MtnConfig.feed.candidateSources.recencyWindowMs);
  const rows = await getDb()
    .select({
      postId: likes.postId,
      total: sql<number>`count(*)::int`,
      actorIds: sql<
        string[]
      >`(array_agg(${likes.userId} order by ${likes.createdAt} desc, ${likes.userId}))[1:3]`,
    })
    .from(likes)
    .innerJoin(posts, eq(posts.id, likes.postId))
    .where(
      and(
        inArray(likes.postId, postIds),
        inArray(likes.userId, actorIds),
        publicPositiveLikeSql(),
        gte(likes.createdAt, since),
        lte(likes.createdAt, asOf),
        eq(posts.status, 'published'),
        eq(posts.visibility, 'public'),
      ),
    )
    .groupBy(likes.postId);
  const withoutLikes = postIds.filter((id) => !rows.some((row) => row.postId === id));
  const boostRows = withoutLikes.length
    ? await getDb()
        .select({
          postId: posts.boostOf,
          total: sql<number>`count(distinct ${posts.oxyUserId})::int`,
          actorIds: sql<
            string[]
          >`(array_agg(distinct ${posts.oxyUserId} order by ${posts.oxyUserId}))[1:3]`,
        })
        .from(posts)
        .where(
          and(
            inArray(posts.boostOf, withoutLikes),
            inArray(posts.oxyUserId, actorIds),
            eq(posts.type, 'boost'),
            eq(posts.status, 'published'),
            eq(posts.visibility, 'public'),
            gte(posts.createdAt, since),
            lte(posts.createdAt, asOf),
            sql`exists (select 1 from posts social_original where social_original.id = ${posts.boostOf} and social_original.status = 'published' and social_original.visibility = 'public')`,
          ),
        )
        .groupBy(posts.boostOf)
    : [];
  const evidenceRows = [
    ...rows.map((row) => ({ ...row, type: 'likedBy' as const })),
    ...boostRows.map((row) => ({ ...row, type: 'boostedBy' as const })),
  ];
  const summaries = await resolveUserSummaries([
    ...new Set(evidenceRows.flatMap((row) => row.actorIds)),
  ]);
  const byId = new Map(evidenceRows.map((row) => [row.postId, row]));
  for (let i = 0; i < slices.length; i++) {
    const postId = targets[i];
    const evidence = postId ? byId.get(postId) : undefined;
    if (!evidence || !postId) continue;
    const actors = evidence.actorIds.flatMap((id) => {
      const user = summaries.get(id)?.user;
      return user ? [user] : [];
    });
    if (actors.length)
      slices[i].socialContext = { type: evidence.type, postId, actors, total: evidence.total };
  }
}

/** Optional annotation fails neutral; source/continuation eligibility never uses this fallback. */
export async function attachSocialFeedContext(
  slices: FeedPostSlice[],
  ctx: FeedEngineContext,
): Promise<void> {
  for (const slice of slices) delete slice.socialContext;
  try {
    await attachCurrentSocialFeedContext(slices, ctx);
  } catch {
    logger.warn('[SocialFeedEvidence] Optional actor context unavailable');
  }
}
