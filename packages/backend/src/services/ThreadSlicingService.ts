/**
 * Thread Slicing Service
 *
 * Groups flat feed posts into FeedPostSlice arrays for thread rendering.
 * Two operations:
 *   1. Self-thread grouping: posts with same threadId + same oxyUserId → single slice
 *   2. Reply context injection: posts with parentPostId → prepend parent as context
 */

import {
  FeedPostSlice,
  FeedSliceItem,
  FeedSliceReason,
  HydratedPost,
  MtnConfig,
  PostVisibility,
} from '@mention/shared-types';
import { and, asc, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import { posts as postsTable } from '../db/schema/posts';
import { CHRONO_DESC, findPostRecords } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { logger } from '../utils/logger';

export interface ThreadSlicingOptions {
  enableThreadGrouping: boolean;
  enableReplyContext: boolean;
  maxSliceSize: number; // max posts per slice (default 3)
  viewerId?: string;
}

interface RawPost {
  id: string;
  /** Nullable column, not merely optional — see `PostRecord`. */
  oxyUserId?: string | null;
  /** Written as a reply. STORED, never inferred from `parentPostId`. */
  isReply: boolean;
  parentPostId?: string | null;
  threadId?: string | null;
  createdAt?: string | Date;
}

/**
 * A lean document from THIS service's own two Mongo queries, as a {@link RawPost}.
 *
 * `models/Post` is still Mongoose, so it yields `_id` and has no stored
 * `is_reply`; `RawPost` speaks the ported vocabulary. Bridging them with a bare
 * cast produced objects whose `id` was `undefined`, and the damage was silent:
 * `_sliceKey` became `"undefined+…"`, `additionalPostIds` handed hydration an
 * `undefined` id, and the `seenPostIds` guard deduped every fetched parent
 * against the single key `undefined` — so on a page with two replies to two
 * DIFFERENT parents, only the first reply got its parent prepended.
 *
 * Deriving `isReply` is correct only because these documents predate the stored
 * column; it goes through the shared {@link derivesReplyIntent} so the two
 * encodings of "has a parent" cannot drift from the writer's definition.
 */
function toRawPost(record: PostRecord): RawPost {
  // `isReply` is READ, no longer re-derived: it is a stored column now, and it is
  // the only answer that survives `ON DELETE SET NULL` clearing a parent link.
  return record as unknown as RawPost;
}

const DEFAULT_OPTIONS: ThreadSlicingOptions = {
  enableThreadGrouping: true,
  enableReplyContext: true,
  maxSliceSize: MtnConfig.feed.maxSliceSize,
};

class ThreadSlicingService {
  /**
   * Takes a flat array of feed posts (already ranked/sorted) and groups them
   * into slices. Returns slices + IDs of any additional posts fetched (parents,
   * thread children) that need hydration.
   */
  async sliceFeed(
    posts: RawPost[],
    options: Partial<ThreadSlicingOptions> = {}
  ): Promise<{ slices: FeedPostSlice[]; additionalPostIds: string[] }> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    if (posts.length === 0) {
      return { slices: [], additionalPostIds: [] };
    }

    const seenPostIds = new Set<string>();
    const additionalPostIds: string[] = [];

    // Index posts by id for fast lookup
    const postById = new Map<string, RawPost>();
    for (const p of posts) {
      const id = getPostId(p);
      postById.set(id, p);
    }

    // Gather thread children and parent posts in parallel
    const [threadChildrenMap, parentPostMap] = await Promise.all([
      opts.enableThreadGrouping
        ? this.fetchThreadChildren(posts, opts.maxSliceSize)
        : Promise.resolve(new Map<string, RawPost[]>()),
      opts.enableReplyContext
        ? this.fetchParentPosts(posts, postById)
        : Promise.resolve(new Map<string, RawPost>()),
    ]);

    // Track additional post IDs that were fetched and need hydration
    for (const children of threadChildrenMap.values()) {
      for (const child of children) {
        const childId = getPostId(child);
        if (!postById.has(childId)) {
          additionalPostIds.push(childId);
        }
      }
    }
    for (const parentId of parentPostMap.keys()) {
      if (!postById.has(parentId)) {
        additionalPostIds.push(parentId);
      }
    }

    // The slicer no longer resolves parent AUTHORS. "Replying to @<parent
    // author>" is rendered from the reply's own `replyContext` on the post DTO,
    // which PostHydrationService fills for every post on every surface — so
    // resolving them a second time here would be a duplicate carrier for one
    // fact, and only for the handful of feeds whose definition opts into reply
    // slicing. Slicing keeps the job nothing else can do: prepending the parent
    // POST so the pair renders as one connected thread.

    // Build slices in feed order
    const slices: FeedPostSlice[] = [];

    for (const post of posts) {
      const postId = getPostId(post);

      // Skip if already consumed by a previous slice
      if (seenPostIds.has(postId)) continue;

      seenPostIds.add(postId);

      // Try self-thread grouping: root post with thread children by the same author
      if (opts.enableThreadGrouping && post.threadId && !post.isReply) {
        const children = threadChildrenMap.get(post.threadId);
        if (children && children.length > 0) {
          const sliceItems: RawPost[] = [post];
          for (const child of children) {
            const childId = getPostId(child);
            if (!seenPostIds.has(childId)) {
              seenPostIds.add(childId);
              sliceItems.push(child);
              if (sliceItems.length >= opts.maxSliceSize) break;
            }
          }

          if (sliceItems.length > 1) {
            const totalChildren = children.length;
            const isIncomplete = totalChildren > sliceItems.length - 1; // -1 for root

            slices.push(buildSlice(sliceItems, isIncomplete, { type: 'selfThread' }));
            continue;
          }
        }
      }

      // Reply context: a reply is ALWAYS tagged `replyContext`, and its parent is
      // prepended when we actually hold it.
      //
      // The reply test is the STORED `isReply`, NOT `post.parentPostId` — a
      // federated reply whose `inReplyTo` never resolved carries no local parent
      // link and would otherwise be classified as a thread root.
      //
      // The parent is unattachable in three cases: it is already rendered higher
      // in this page, it failed the published/visibility bar, or it was never
      // ingested. In all three the slice still carries the `replyContext` reason,
      // which the `hideReplies` tuner filters on. The "Replying to @…" header does
      // NOT depend on this tag — it reads the reply's own `replyContext` on the
      // post DTO, so a reply renders its context on feeds that never slice at all.
      if (opts.enableReplyContext && post.isReply) {
        const parentId = post.parentPostId;
        const parent = parentId ? parentPostMap.get(parentId) ?? postById.get(parentId) : undefined;
        const attachableParent =
          parent && !seenPostIds.has(getPostId(parent)) ? parent : undefined;
        if (attachableParent) {
          seenPostIds.add(getPostId(attachableParent));
        }

        slices.push(buildSlice(
          attachableParent ? [attachableParent, post] : [post],
          true,
          { type: 'replyContext' },
        ));
        continue;
      }

      // Default: single-post slice
      slices.push(buildSlice([post], false));
    }

    return { slices, additionalPostIds };
  }

  /**
   * Fetch thread children for self-thread grouping.
   * For each thread root in the feed, fetch up to maxSliceSize-1 children
   * by the same author, sorted chronologically.
   */
  private async fetchThreadChildren(
    posts: RawPost[],
    maxSliceSize: number
  ): Promise<Map<string, RawPost[]>> {
    const result = new Map<string, RawPost[]>();

    // Collect thread roots (posts with threadId, no parentPostId)
    const threadRoots = new Map<string, string>(); // threadId → oxyUserId
    for (const post of posts) {
      if (post.threadId && !post.parentPostId && post.oxyUserId) {
        threadRoots.set(post.threadId, post.oxyUserId);
      }
    }

    if (threadRoots.size === 0) return result;

    // One (thread, author) pair per root, OR-ed together.
    const threadConditions = Array.from(threadRoots.entries()).map(([threadId, oxyUserId]) =>
      and(
        eq(postsTable.threadId, threadId),
        eq(postsTable.oxyUserId, oxyUserId),
        // `is not null`, NOT `<> null`: Mongo's `$ne: null` also matched a missing
        // field, while SQL's `<>` against NULL is NULL and matches nothing — the
        // literal translation would return no continuations at all and silently
        // un-thread every self-thread in the feed.
        isNotNull(postsTable.parentPostId),
      ) as SQL,
    );

    try {
      const children = await findPostRecords(
        and(
          eq(postsTable.visibility, PostVisibility.PUBLIC),
          eq(postsTable.status, 'published'),
          or(...threadConditions),
        ),
        {
          orderBy: [asc(postsTable.createdAt), asc(postsTable.id)],
          limit: threadRoots.size * (maxSliceSize - 1),
        },
      );

      // Group children by threadId
      for (const child of children) {
        const tid = child.threadId;
        if (!tid) continue;
        let arr = result.get(tid);
        if (!arr) {
          arr = [];
          result.set(tid, arr);
        }
        if (arr.length < maxSliceSize - 1) {
          arr.push(toRawPost(child));
        }
      }
    } catch (err) {
      logger.error('[ThreadSlicing] Error fetching thread children', err);
    }

    return result;
  }

  /**
   * Fetch parent posts for reply context injection.
   * For replies in the feed whose parent is not already in the feed,
   * fetch the parent post.
   */
  private async fetchParentPosts(
    posts: RawPost[],
    postById: Map<string, RawPost>
  ): Promise<Map<string, RawPost>> {
    const result = new Map<string, RawPost>();

    // Collect parent IDs that are not in the current feed
    const missingParentIds: string[] = [];
    for (const post of posts) {
      if (post.parentPostId && !postById.has(post.parentPostId)) {
        missingParentIds.push(post.parentPostId);
      }
    }

    if (missingParentIds.length === 0) return result;

    // Deduplicate
    const uniqueParentIds = [...new Set(missingParentIds)];

    try {
      const parents = await findPostRecords(
        and(
          inArray(postsTable.id, uniqueParentIds),
          // A reply-context parent is injected into whatever feed the reply landed
          // in, so it must clear the same publication bar as every feed candidate:
          // a draft or scheduled parent must never be rendered as reply context.
          // `visibility` is deliberately NOT filtered here — hydration re-checks
          // post ACL per viewer, and a followers-only parent that a follower IS
          // entitled to see must still reach them.
          eq(postsTable.status, 'published'),
        ),
        // Re-keyed by id below, so the order is required by the signature rather
        // than observed by anything.
        { orderBy: CHRONO_DESC },
      );

      for (const parent of parents) {
        const raw = toRawPost(parent);
        result.set(raw.id, raw);
      }
    } catch (err) {
      logger.error('[ThreadSlicing] Error fetching parent posts', err);
    }

    return result;
  }

}

function getPostId(post: RawPost): string {
  return post.id;
}

/**
 * Assign thread state (isThreadParent/Child/LastChild) based on position in a slice.
 * Single-item slices have no thread state.
 */
export function assignThreadState(items: FeedSliceItem[]): FeedSliceItem[] {
  if (items.length <= 1) {
    return items.map((item) => ({
      ...item,
      isThreadParent: false,
      isThreadChild: false,
      isThreadLastChild: false,
    }));
  }

  return items.map((item, idx) => ({
    ...item,
    isThreadParent: idx < items.length - 1,
    isThreadChild: idx > 0,
    isThreadLastChild: idx === items.length - 1,
  }));
}

function buildSlice(
  posts: RawPost[],
  isIncompleteThread: boolean,
  reason?: FeedSliceReason
): FeedPostSlice {
  const rawItems: FeedSliceItem[] = posts.map((post) => ({
    // Raw lean doc placeholder: PostHydrationService.hydrateSlices replaces this
    // with the real HydratedPost (it reads the raw fields back via RawPost).
    post: post as unknown as HydratedPost,
    isThreadParent: false,
    isThreadChild: false,
    isThreadLastChild: false,
  }));

  const items = assignThreadState(rawItems);

  return {
    _sliceKey: posts.map(getPostId).join('+'),
    items,
    isIncompleteThread,
    reason,
  };
}

export const threadSlicingService = new ThreadSlicingService();
