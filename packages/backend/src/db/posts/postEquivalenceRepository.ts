/**
 * The ONLY module that knows a cross-post cluster is two tables plus one
 * write-time projection on `posts`.
 *
 * `services/PostEquivalenceService` decides WHAT is equivalent; this decides
 * nothing and only writes it down. The split matters because the projection
 * (`posts.crosspost_collapsed`) and the authority (`post_equivalence_members.
 * preferred`) must never disagree — a collapsed post whose cluster does not
 * exist is a post nobody can see through any feed, and it has no symptom other
 * than an author asking where their post went. Every write below moves both, in
 * one transaction.
 */

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { postEquivalenceClusters, postEquivalenceMembers, posts } from '../schema/posts';

/** One member of a cluster, as the service reads it. */
export interface EquivalenceMemberRecord {
  id: string;
  clusterId: string;
  postId: string;
  networkDomain: string;
  preferred: boolean;
  evidence: string;
}

/** A cluster and everything in it. */
export interface EquivalenceClusterRecord {
  id: string;
  kind: 'crosspost';
  confidence: (typeof postEquivalenceClusters.$inferSelect)['confidence'];
  members: EquivalenceMemberRecord[];
}

type MemberRow = typeof postEquivalenceMembers.$inferSelect;

function assembleMember(row: MemberRow): EquivalenceMemberRecord {
  return {
    id: row.id,
    clusterId: row.clusterId,
    postId: row.postId,
    networkDomain: row.networkDomain,
    preferred: row.preferred,
    evidence: row.evidence,
  };
}

/** The cluster a post belongs to, with every member, or `null`. */
export async function findClusterByPostId(
  postId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<EquivalenceClusterRecord | null> {
  const [member] = await db
    .select({ clusterId: postEquivalenceMembers.clusterId })
    .from(postEquivalenceMembers)
    .where(eq(postEquivalenceMembers.postId, postId))
    .limit(1);
  return member ? findClusterById(member.clusterId, db) : null;
}

/** A cluster by id, with every member. */
export async function findClusterById(
  clusterId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<EquivalenceClusterRecord | null> {
  const [cluster] = await db
    .select()
    .from(postEquivalenceClusters)
    .where(eq(postEquivalenceClusters.id, clusterId))
    .limit(1);
  if (!cluster) return null;

  const members = await db
    .select()
    .from(postEquivalenceMembers)
    .where(eq(postEquivalenceMembers.clusterId, clusterId))
    .orderBy(desc(postEquivalenceMembers.preferred), postEquivalenceMembers.postId);

  return { id: cluster.id, kind: cluster.kind, confidence: cluster.confidence, members: members.map(assembleMember) };
}

/** One member to write. `preferred` is decided by the service, never here. */
export interface EquivalenceMemberWrite {
  postId: string;
  networkDomain: string;
  preferred: boolean;
  evidence: string;
}

/**
 * Create a cluster from two or more members, and collapse every non-preferred
 * one, atomically.
 *
 * Atomic because the two halves are the same fact written twice: a committed
 * member row with an uncommitted projection shows a duplicate card (harmless and
 * self-correcting), but a committed projection with no member row hides a post
 * from every surface with nothing to explain it. One transaction removes the
 * second possibility entirely.
 */
export async function createCluster(
  confidence: EquivalenceClusterRecord['confidence'],
  members: readonly EquivalenceMemberWrite[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string> {
  return db.transaction(async (tx) => {
    const [cluster] = await tx
      .insert(postEquivalenceClusters)
      .values({ kind: 'crosspost', confidence })
      .returning({ id: postEquivalenceClusters.id });

    await tx.insert(postEquivalenceMembers).values(
      members.map((member) => ({
        clusterId: cluster.id,
        postId: member.postId,
        networkDomain: member.networkDomain,
        preferred: member.preferred,
        evidence: member.evidence,
      })),
    );

    await applyCollapseProjection(cluster.id, tx);
    return cluster.id;
  });
}

/** Add a member to an existing cluster, then re-apply the projection. */
export async function addClusterMember(
  clusterId: string,
  member: EquivalenceMemberWrite,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(postEquivalenceMembers).values({
      clusterId,
      postId: member.postId,
      networkDomain: member.networkDomain,
      preferred: member.preferred,
      evidence: member.evidence,
    });
    await applyCollapseProjection(clusterId, tx);
  });
}

/**
 * Move `preferred` to one member and re-apply the projection.
 *
 * The clear runs before the set because `post_equivalence_members_preferred_key`
 * is a partial UNIQUE index over `cluster_id` — two preferred members cannot
 * exist even transiently inside the statement pair, so setting first would fail.
 */
export async function setPreferredMember(
  clusterId: string,
  postId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(postEquivalenceMembers)
      .set({ preferred: false })
      .where(and(
        eq(postEquivalenceMembers.clusterId, clusterId),
        ne(postEquivalenceMembers.postId, postId),
      ));
    await tx
      .update(postEquivalenceMembers)
      .set({ preferred: true })
      .where(and(
        eq(postEquivalenceMembers.clusterId, clusterId),
        eq(postEquivalenceMembers.postId, postId),
      ));
    await applyCollapseProjection(clusterId, tx);
  });
}

/**
 * Remove one post from its cluster and make it visible again.
 *
 * The caller decides whether what remains is still a cluster —
 * {@link dissolveCluster} is the other half.
 */
export async function removeClusterMember(
  clusterId: string,
  postId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(postEquivalenceMembers)
      .where(and(
        eq(postEquivalenceMembers.clusterId, clusterId),
        eq(postEquivalenceMembers.postId, postId),
      ));
    await tx.update(posts).set({ crosspostCollapsed: false }).where(eq(posts.id, postId));
    await applyCollapseProjection(clusterId, tx);
  });
}

/** Delete a cluster and un-collapse every post that was in it. */
export async function dissolveCluster(
  clusterId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const members = await tx
      .select({ postId: postEquivalenceMembers.postId })
      .from(postEquivalenceMembers)
      .where(eq(postEquivalenceMembers.clusterId, clusterId));
    // The member rows go with the cluster by `ON DELETE cascade`; the projection
    // does not, so it is cleared FIRST, while the ids are still readable.
    if (members.length > 0) {
      await tx
        .update(posts)
        .set({ crosspostCollapsed: false })
        .where(inArray(posts.id, members.map((member) => member.postId)));
    }
    await tx.delete(postEquivalenceClusters).where(eq(postEquivalenceClusters.id, clusterId));
  });
}

/**
 * Re-derive `posts.crosspost_collapsed` for every member of one cluster from
 * `preferred`, which is the authority.
 *
 * Written as two statements driven by the member table rather than as a
 * per-post update, so the projection cannot drift from the rows it projects even
 * if a caller forgets a member.
 */
async function applyCollapseProjection(
  clusterId: string,
  tx: DatabaseOrTransaction,
): Promise<void> {
  await tx
    .update(posts)
    .set({ crosspostCollapsed: sql`not ${postEquivalenceMembers.preferred}` })
    .from(postEquivalenceMembers)
    .where(and(
      eq(postEquivalenceMembers.postId, posts.id),
      eq(postEquivalenceMembers.clusterId, clusterId),
    ));
}

/** The clusters these posts belong to — read BEFORE a delete cascades them away. */
export async function findClusterIdsForPosts(
  postIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (postIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ clusterId: postEquivalenceMembers.clusterId })
    .from(postEquivalenceMembers)
    .where(inArray(postEquivalenceMembers.postId, [...postIds]));
  return rows.map((row) => row.clusterId);
}

/** How many clusters and collapsed posts exist — the reconciliation report's counters. */
export async function countEquivalence(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ clusters: number; collapsedPosts: number }> {
  const [clusters] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postEquivalenceClusters);
  const [collapsed] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(posts)
    .where(eq(posts.crosspostCollapsed, true));
  return { clusters: clusters?.count ?? 0, collapsedPosts: collapsed?.count ?? 0 };
}
