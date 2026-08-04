import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';

/**
 * Scheduled posts that depend on one another — the ordering rules for a thread
 * whose publication is still in the future.
 *
 * A THREAD's continuations are created as replies to each other: continuation
 * `n` carries continuation `n-1` as its `parentPostId`. A beast batch is the
 * opposite — n independent posts that merely share a composer — which is why
 * beast batches were schedulable long before threads were. The whole difficulty
 * of a scheduled thread is one invariant:
 *
 *   **No continuation is ever visible before its parent.**
 *
 * Two mechanisms uphold it, and they are deliberately independent:
 *
 * 1. `PostCreationService.claimAndPublishScheduledPost` REFUSES to claim a post
 *    whose parent exists and has not published. That is structural: it holds for
 *    every caller, in every order, under any interleaving, and it is what makes
 *    a partial failure safe rather than merely unlikely.
 * 2. This module orders the work so the normal path never needs mechanism 1 —
 *    the sweep walks each chain parent-first and stops at the first post that
 *    does not publish, so a thread goes out whole and in order.
 *
 * Mechanism 1 is sound WITHOUT a transaction because `scheduled -> published` is
 * one-way: nothing ever un-publishes a post. A check of the parent taken before
 * the claim can therefore only be conservative. It may read "not published" for
 * a parent that publishes a microsecond later — the child simply waits for the
 * next sweep — but it can never read "published" for a parent that is not, since
 * the only writer that could produce that reading has already committed.
 */

/**
 * Group posts into publication chains, each ordered parent before child.
 *
 * A post whose `parentPostId` names another post in `posts` is that post's
 * child; everything else starts a chain of its own. Independent posts (a beast
 * batch, a lone scheduled post) come back as single-element chains, so the
 * caller needs no special case for them.
 *
 * Branching is tolerated even though a composed thread is linear: two replies to
 * the same parent simply both follow it. Cycles cannot arise from a client —
 * `parentPostId` is resolved server-side — but a `seen` set bounds the walk
 * anyway, because the alternative to a cheap bound here is a hung sweep.
 */
export function orderScheduledChains<T extends { id: string; parentPostId?: string | null }>(
  duePosts: T[],
): T[][] {
  const byId = new Map<string, T>();
  for (const post of duePosts) {
    byId.set(post.id, post);
  }

  const childrenByParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const post of duePosts) {
    const parentId = post.parentPostId ?? null;
    if (parentId !== null && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId);
      if (siblings) {
        siblings.push(post);
      } else {
        childrenByParent.set(parentId, [post]);
      }
    } else {
      // No parent, or a parent outside this set — either way nothing here has to
      // publish before it.
      roots.push(post);
    }
  }

  const seen = new Set<string>();
  return roots.map((root) => {
    const chain: T[] = [];
    const pending: T[] = [root];
    while (pending.length > 0) {
      const post = pending.shift() as T;
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      chain.push(post);
      pending.push(...(childrenByParent.get(post.id) ?? []));
    }
    return chain;
  });
}

/**
 * The minimal projection the chain walk reads.
 *
 * A narrow select rather than a whole `PostRecord`: assembling a record joins
 * nine tables, and the walk is several round trips deep by construction. None of
 * these four columns is nullable except the two the schema declares nullable, so
 * there is no absent-field branch to carry across from the Mongo shape —
 * `status` in particular is `NOT NULL DEFAULT 'published'`, which is why the
 * `?? 'published'` fallbacks the Mongo version needed are gone rather than
 * translated.
 */
interface ChainNode {
  id: string;
  status: string;
  oxyUserId: string | null;
  parentPostId: string | null;
}

const CHAIN_COLUMNS = {
  id: posts.id,
  status: posts.status,
  oxyUserId: posts.oxyUserId,
  parentPostId: posts.parentPostId,
} as const;

/** One chain node by id, or null when the post is gone. */
async function loadChainNode(postId: string): Promise<ChainNode | null> {
  const [row] = await getDb()
    .select(CHAIN_COLUMNS)
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return row ?? null;
}

export type ScheduledChainResolution =
  | { ok: true; postIds: string[] }
  /**
   * An ancestor is still scheduled and belongs to somebody else, so the caller
   * cannot publish the chain in order — and publishing their own part of it
   * would put a reply on screen ahead of the post it answers.
   */
  | { ok: false; reason: 'foreign_scheduled_ancestor' };

/**
 * Every one of `ownerId`'s still-scheduled posts that publishes together with
 * `postId`, ordered parent before child.
 *
 * The chain is what a scheduled thread IS from the queue's point of view: one
 * unit with one publish moment. Cancelling, rescheduling and publishing early
 * all act on it rather than on a single row, because acting on a single row
 * produces states nobody asked for — a continuation orphaned behind a cancelled
 * parent, a thread with three different publish times, half a thread on screen.
 *
 * Walks UP to the chain root first (an ancestor that has already published, or
 * no longer exists, ends the walk — the invariant is about a parent that is
 * still to come), then DOWN through every scheduled descendant.
 */
export async function loadScheduledChain(
  postId: string,
  ownerId: string,
): Promise<ScheduledChainResolution> {
  const start = await loadChainNode(postId);
  if (!start) {
    return { ok: true, postIds: [] };
  }

  // Up to the root.
  let root = start;
  const climbed = new Set<string>([start.id]);
  while (root.parentPostId) {
    const parent = await loadChainNode(root.parentPostId);
    // A parent that has published, or that is gone, is not something this chain
    // has to wait for.
    if (!parent || parent.status !== 'scheduled') break;
    if (parent.oxyUserId !== ownerId) {
      return { ok: false, reason: 'foreign_scheduled_ancestor' };
    }
    if (climbed.has(parent.id)) break;
    climbed.add(parent.id);
    root = parent;
  }

  // Down through the scheduled descendants, oldest first so a chain comes back
  // in the order it was composed.
  const postIds: string[] = [];
  const visited = new Set<string>();
  const pending: ChainNode[] = [root];
  while (pending.length > 0) {
    const post = pending.shift() as ChainNode;
    if (visited.has(post.id)) continue;
    visited.add(post.id);
    postIds.push(post.id);

    // Ordered by `created_at` alone, with no id tie-break: `posts.id` holds both
    // pre-cutover ObjectId hex and post-cutover uuid v7, so it is not a
    // chronological axis and adding it would order a mixed sibling set WORSE
    // than leaving the tie arbitrary. A composed thread is linear anyway — every
    // post has one child — so siblings only arise from independent replies,
    // which have no composed order to preserve.
    const children = await getDb()
      .select(CHAIN_COLUMNS)
      .from(posts)
      .where(and(
        eq(posts.parentPostId, post.id),
        eq(posts.oxyUserId, ownerId),
        eq(posts.status, 'scheduled'),
      ))
      .orderBy(asc(posts.createdAt));
    pending.push(...children);
  }

  return { ok: true, postIds };
}

/**
 * Whether `post` may publish yet: true unless its parent exists and has not
 * published.
 *
 * A MISSING parent passes. The invariant is "no continuation before its parent",
 * which is vacuous when there is no parent to precede — and a scheduled reply
 * whose parent was deleted between scheduling and publish must still go out
 * rather than wedge in the queue forever.
 */
export async function parentHasPublished(post: { parentPostId?: string | null }): Promise<boolean> {
  if (!post.parentPostId) return true;
  const [parent] = await getDb()
    .select({ status: posts.status })
    .from(posts)
    .where(eq(posts.id, post.parentPostId))
    .limit(1);
  if (!parent) return true;
  return parent.status === 'published';
}
