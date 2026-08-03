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
import { Post } from '../models/Post';
import { logger } from '../utils/logger';
import { isReplyPost } from '../utils/postReply';

export interface ThreadSlicingOptions {
  enableThreadGrouping: boolean;
  enableReplyContext: boolean;
  maxSliceSize: number; // max posts per slice (default 3)
  viewerId?: string;
}

interface RawPost {
  // Feed candidates come from several ranked sources with differently-typed ids
  // (ObjectId, string, or an opaque `{ toString() }`); only `getPostId` reads it.
  _id: unknown;
  id?: string;
  oxyUserId?: string;
  parentPostId?: string;
  threadId?: string;
  createdAt?: string | Date;
}

const DEFAULT_OPTIONS: ThreadSlicingOptions = {
  enableThreadGrouping: true,
  enableReplyContext: true,
  maxSliceSize: MtnConfig.feed.maxSliceSize,
};

/**
 * The projection for the posts the slicer pulls in itself — self-thread children
 * and reply-context parents. Both queries share it because they feed the same
 * consumer.
 *
 * `status` is part of it deliberately. These lean docs go straight to
 * `PostHydrationService`, whose unpublished guard reads `post.status ?? 'published'`:
 * leave the field unprojected and that guard reads `undefined`, defaults to
 * `'published'`, and never fires — an inert ACL rather than an enforced one.
 *
 * `writtenByOxyUserId` is here for the same reason it is in the three other
 * hydration projections (see `mtn/feed/FeedAPI.ts`): without it a disclosed
 * channel writer is named on the feed row and silently dropped on the SAME post
 * rendered as a thread parent.
 */
const SLICE_POST_PROJECTION =
  '_id oxyUserId writtenByOxyUserId authorship federation createdAt parentPostId threadId content status stats metadata hashtags mentions language visibility type boostOf quoteOf laneId';

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
      if (opts.enableThreadGrouping && post.threadId && !isReplyPost(post)) {
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
      // The reply test is `isReplyPost`, NOT `post.parentPostId` — a federated
      // reply whose `inReplyTo` never resolved carries no local parent link and
      // would otherwise be classified as a thread root (see `utils/postReply`).
      //
      // The parent is unattachable in three cases: it is already rendered higher
      // in this page, it failed the published/visibility bar, or it was never
      // ingested. In all three the slice still carries the `replyContext` reason,
      // which the `hideReplies` tuner filters on. The "Replying to @…" header does
      // NOT depend on this tag — it reads the reply's own `replyContext` on the
      // post DTO, so a reply renders its context on feeds that never slice at all.
      if (opts.enableReplyContext && isReplyPost(post)) {
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

    // Build $or conditions for each thread
    const orConditions = Array.from(threadRoots.entries()).map(([threadId, oxyUserId]) => ({
      threadId,
      oxyUserId,
      parentPostId: { $ne: null, $exists: true },
    }));

    try {
      const children = await Post.find({
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        $or: orConditions,
      })
        .select(SLICE_POST_PROJECTION)
        .sort({ createdAt: 1 })
        .limit(threadRoots.size * (maxSliceSize - 1))
        .maxTimeMS(3000)
        .lean();

      // Group children by threadId
      for (const child of children) {
        const tid = child.threadId as string;
        if (!result.has(tid)) {
          result.set(tid, []);
        }
        const arr = result.get(tid)!;
        if (arr.length < maxSliceSize - 1) {
          arr.push(child as unknown as RawPost);
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
      const parents = await Post.find({
        _id: { $in: uniqueParentIds },
        // A reply-context parent is injected into whatever feed the reply landed
        // in, so it must clear the same publication bar as every feed candidate:
        // a draft or scheduled parent must never be rendered as reply context.
        // `visibility` is deliberately NOT filtered here — hydration re-checks
        // post ACL per viewer, and a followers-only parent that a follower IS
        // entitled to see must still reach them.
        status: 'published',
      })
        .select(SLICE_POST_PROJECTION)
        .maxTimeMS(3000)
        .lean();

      for (const parent of parents) {
        const parentId = parent._id.toString();
        result.set(parentId, parent as unknown as RawPost);
      }
    } catch (err) {
      logger.error('[ThreadSlicing] Error fetching parent posts', err);
    }

    return result;
  }

}

function getPostId(post: RawPost): string {
  return post.id || (post._id != null ? String(post._id) : '');
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
