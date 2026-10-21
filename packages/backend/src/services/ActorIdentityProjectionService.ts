import { and, asc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { federatedActors } from '../db/schema/federation';
import { mutes } from '../db/schema/engagement';
import { posts, postEquivalenceMembers } from '../db/schema/posts';
import { invalidate as invalidateUsers } from './userSummaryCache';
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';

export interface ActorIdentityProjectionInput {
  /** Immutable source URI (an AP actor URI or native AT Protocol DID). */
  actorUri: string;
  /** Current Oxy-authoritative projection, verified by the calling resolver. */
  oxyUserId: string;
  networkAcct?: string;
  dryRun?: boolean;
  /** Administrative batches own flushing; live callers invalidate immediately. */
  cacheInvalidation?: ActorProjectionCacheInvalidation;
  /**
   * Which of the source's posts to examine. See {@link unprojectedPosts}.
   *
   * - `'refresh'` — what a live actor refresh passes: the posts whose
   *   `oxy_user_id` is not the current id. That is the drift writes produce (a
   *   post ingested under the id the source had before), and the index answers
   *   it without reading the source's posts.
   * - `'audit'` (the default, and what the administrative reconciliation runs):
   *   ALSO the posts whose owner authorship row disagrees with `oxy_user_id`.
   *   No writer produces that, and finding it costs a probe per post of the
   *   source, so it is not paid on every refresh.
   */
  check?: 'refresh' | 'audit';
}
export interface ActorIdentityProjectionResult {
  actorChanged: boolean;
  postsChanged: number;
  authorshipConflicts: number;
  clustersDissolved: number;
  mutesPreserved: number;
  previousUserIds: string[];
  oxyUserId: string;
  refusal?: 'actor_not_cached';
}

export interface ActorProjectionCacheInvalidation {
  record(userIds: readonly string[]): void;
}

async function invalidateAnonymousFeeds(): Promise<void> {
  const redis = getRedisClient();
  if (redis.isReady) {
    try {
      for await (const keys of redis.scanIterator({ MATCH: 'anonfeed:*', COUNT: 100 }))
        if (keys.length) await redis.del(keys);
    } catch (error) {
      logger.warn('[ActorIdentityProjection] feed cache invalidation failed', { error });
    }
  }
}

/** IDs live for one admin batch; anonymous snapshots already expire after 45s. */
export function createActorProjectionCacheBatch() {
  const pending = new Set<string>();
  let feedsChanged = false;
  return {
    record(userIds: readonly string[]) {
      for (const id of userIds) pending.add(id);
      feedsChanged = true;
    },
    async flushUsers() {
      if (!pending.size) return;
      await invalidateUsers([...pending]);
      pending.clear();
    },
    async finish() {
      try {
        await this.flushUsers();
      } finally {
        if (feedsChanged) await invalidateAnonymousFeeds();
        feedsChanged = false;
      }
    },
  };
}

/**
 * The source's posts a projection to `oxyUserId` would move. `p` is the `posts`
 * alias of the statement it goes in.
 *
 * Every check includes the posts whose `oxy_user_id` is not the current id.
 * `posts_federation_actor_author_idx` carries `oxy_user_id` (migration 0069), so
 * that half is a walk of the source's index entries, not a heap page per post.
 *
 * Only an `'audit'` adds the posts whose owner authorship row disagrees with
 * their `oxy_user_id`. That column is the denormalized projection of the owner
 * row and every writer keeps the two in one transaction (`insertChildRows`,
 * `replacePostAuthorship`, the update below), so nothing produces the mismatch;
 * production held none across 2,003,583 owner rows (2026-10-15). Looking for it
 * costs a `post_authorships` probe per post of the source, and when every live
 * refresh paid it, a refresh of an already-projected 2.6k-post actor read ~2.4k
 * `posts` heap pages plus ~2.6k probes, 2.7 s cold: 230 slow-query entries a
 * day, and 137 more for the `previous` read in the caller.
 */
function unprojectedPosts(input: ActorIdentityProjectionInput): SQL {
  const staleColumn = sql`p.oxy_user_id is distinct from ${input.oxyUserId}`;
  const moved =
    input.check === 'refresh'
      ? staleColumn
      : sql`${staleColumn} or exists (select 1 from post_authorships owner where owner.post_id = p.id and owner.role = 'owner' and owner.oxy_user_id <> ${input.oxyUserId})`;
  return sql`p.federation_actor_uri = ${input.actorUri} and (${moved})`;
}

/**
 * Project ONE source, never everything that happens to share its previous Oxy id.
 * No network calls run in the transaction. The caller obtains current authority
 * from Oxy; a later unlink runs this same operation with the restored source id.
 */
export async function reconcileActorIdentityProjection(
  input: ActorIdentityProjectionInput,
): Promise<ActorIdentityProjectionResult> {
  if (!input.actorUri || !input.oxyUserId)
    throw new Error('A source actor and authoritative Oxy user are required');
  const result = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`actor-projection:${input.actorUri}`}))`,
    );
    const [actor] = await tx
      .select()
      .from(federatedActors)
      .where(eq(federatedActors.uri, input.actorUri))
      .for('update');
    const result: ActorIdentityProjectionResult = {
      actorChanged: false,
      postsChanged: 0,
      authorshipConflicts: 0,
      clustersDissolved: 0,
      mutesPreserved: 0,
      previousUserIds: [],
      oxyUserId: input.oxyUserId,
    };
    if (!actor) return { ...result, refusal: 'actor_not_cached' as const };
    // The other ids this source's posts still carry. The current id is left out
    // on purpose: every reader below either drops it (`priorIds`) or adds it back
    // (`changedIds`), and an already-projected source then answers this from
    // `posts_federation_actor_author_idx` rather than a heap page per post.
    const previous = await tx
      .selectDistinct({ userId: posts.oxyUserId })
      .from(posts)
      .where(
        and(
          eq(posts.federationActorUri, input.actorUri),
          sql`${posts.oxyUserId} is distinct from ${input.oxyUserId}`,
        ),
      );
    result.previousUserIds = [
      ...new Set(
        [actor.oxyUserId, ...previous.map((row) => row.userId)].filter((id): id is string => !!id),
      ),
    ];
    result.actorChanged =
      actor.oxyUserId !== input.oxyUserId ||
      (input.networkAcct !== undefined && actor.networkAcct !== input.networkAcct);
    const [counts] = await tx.execute<{ eligible: number; conflicts: number }>(sql`
      select count(*) filter (where exists (select 1 from post_authorships owner where owner.post_id = p.id and owner.role = 'owner')
        and not exists (select 1 from post_authorships other where other.post_id = p.id and other.role <> 'owner' and other.oxy_user_id = ${input.oxyUserId}))::int as eligible,
        count(*) filter (where not exists (select 1 from post_authorships owner where owner.post_id = p.id and owner.role = 'owner')
        or exists (select 1 from post_authorships other where other.post_id = p.id and other.role <> 'owner' and other.oxy_user_id = ${input.oxyUserId}))::int as conflicts
      from posts p where ${unprojectedPosts(input)}
    `);
    result.postsChanged = counts.eligible;
    result.authorshipConflicts = counts.conflicts;
    if (input.dryRun) return result;
    if (!result.actorChanged && !result.postsChanged) return result;

    // Privacy rows did not record a source actor historically. Retain originals
    // and copy their protection conservatively; never guess which mute to erase.
    const priorIds = result.previousUserIds.filter((id) => id !== input.oxyUserId);
    if (priorIds.length) {
      let cursor: string | undefined;
      while (true) {
        const rows = await tx
          .select()
          .from(mutes)
          .where(
            and(
              or(inArray(mutes.userId, priorIds), inArray(mutes.mutedId, priorIds)),
              cursor ? gt(mutes.id, cursor) : undefined,
            ),
          )
          .orderBy(asc(mutes.id))
          .limit(500);
        if (!rows.length) break;
        const copies = rows.map(({ id: _id, ...row }) => ({
          ...row,
          userId: priorIds.includes(row.userId) ? input.oxyUserId : row.userId,
          mutedId: priorIds.includes(row.mutedId) ? input.oxyUserId : row.mutedId,
        }));
        result.mutesPreserved += (
          await tx.insert(mutes).values(copies).onConflictDoNothing().returning({ id: mutes.id })
        ).length;
        cursor = rows[rows.length - 1].id;
      }
    }
    // Fail open for display: invalidated identity proof can never leave hidden
    // variants waiting for the remote proof service. Re-detection runs separately.
    await tx.execute(sql`update posts set crosspost_collapsed = false where id in (
      select member.post_id from post_equivalence_members member where member.cluster_id in (
        select affected.cluster_id from post_equivalence_members affected join posts source on source.id = affected.post_id where source.federation_actor_uri = ${input.actorUri}))`);
    const [clusters] = await tx.execute<{ count: number }>(sql`with removed as (
      delete from post_equivalence_clusters where id in (
        select affected.cluster_id from post_equivalence_members affected join posts source on source.id = affected.post_id where source.federation_actor_uri = ${input.actorUri}) returning 1
    ) select count(*)::int as count from removed`);
    result.clustersDissolved = clusters.count;
    if (result.postsChanged)
      await tx.execute(sql`with eligible as materialized (
      select p.id from posts p where ${unprojectedPosts(input)}
      and exists (select 1 from post_authorships owner where owner.post_id = p.id and owner.role = 'owner')
      and not exists (select 1 from post_authorships other where other.post_id = p.id and other.role <> 'owner' and other.oxy_user_id = ${input.oxyUserId})
    ), changed_authors as (
      update post_authorships set oxy_user_id = ${input.oxyUserId} where role = 'owner' and oxy_user_id is distinct from ${input.oxyUserId} and post_id in (select id from eligible) returning post_id
    ) update posts set oxy_user_id = ${input.oxyUserId} where id in (select id from eligible) and oxy_user_id is distinct from ${input.oxyUserId}`);
    await tx
      .update(federatedActors)
      .set({
        oxyUserId: input.oxyUserId,
        ...(input.networkAcct !== undefined ? { networkAcct: input.networkAcct } : {}),
      })
      .where(eq(federatedActors.id, actor.id));
    return result;
  });
  const changedIds = [...result.previousUserIds, input.oxyUserId];
  let invalidationRecorded = false;
  const recordInvalidation = () => {
    if (invalidationRecorded || input.dryRun) return;
    input.cacheInvalidation?.record(changedIds);
    invalidationRecorded = true;
  };
  // Record committed writes before re-evaluation can fail. The administrative
  // caller will flush its batch/finally even if this call cannot return a result.
  if (result.actorChanged || result.postsChanged) recordInvalidation();
  try {
    if (!input.dryRun && !result.refusal) {
      const { reevaluateClusters } = await import('./PostEquivalenceService.js');
      let cursor: string | undefined;
      while (true) {
        const clusters = await getDb()
          .selectDistinct({ id: postEquivalenceMembers.clusterId })
          .from(postEquivalenceMembers)
          .innerJoin(posts, eq(posts.id, postEquivalenceMembers.postId))
          .where(
            and(
              eq(posts.federationActorUri, input.actorUri),
              cursor ? gt(postEquivalenceMembers.clusterId, cursor) : undefined,
            ),
          )
          .orderBy(asc(postEquivalenceMembers.clusterId))
          .limit(100);
        if (!clusters.length) break;
        recordInvalidation();
        await reevaluateClusters(clusters.map((row) => row.id));
        cursor = clusters[clusters.length - 1].id;
      }
    }
  } finally {
    if (invalidationRecorded && !input.cacheInvalidation) {
      await invalidateUsers(changedIds);
      await invalidateAnonymousFeeds();
    }
  }
  return result;
}

/** Explicit unmute removes the current Oxy group, including conservative copies. */
export async function activeMuteIdentityIds(targetId: string): Promise<string[]> {
  const { getServiceOxyClient } = await import('../utils/oxyHelpers.js');
  const resolved = await getServiceOxyClient().users.getMany([targetId]);
  const ids = new Set([targetId]);
  for (const user of resolved) {
    if (typeof user.id === 'string') ids.add(user.id);
    const aliases = (user as unknown as { redirectedUserIds?: unknown }).redirectedUserIds;
    if (Array.isArray(aliases)) for (const id of aliases) if (typeof id === 'string') ids.add(id);
  }
  return [...ids];
}
export async function unmuteIdentityProjection(
  viewerId: string,
  targetId: string,
): Promise<number> {
  const ids = await activeMuteIdentityIds(targetId);
  const removed = await getDb()
    .delete(mutes)
    .where(and(eq(mutes.userId, viewerId), inArray(mutes.mutedId, ids)))
    .returning({ id: mutes.id });
  return removed.length;
}
