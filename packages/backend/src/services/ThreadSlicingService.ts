/**
 * Thread Slicing Service
 *
 * Groups flat feed posts into FeedPostSlice arrays for thread rendering.
 * Two operations:
 *   1. Self-thread grouping: posts with same threadId + same oxyUserId → single slice
 *   2. Reply context injection: posts with parentPostId → prepend parent as context
 */

import { FeedPostSlice, FeedSliceItem, FeedSliceReason, MtnConfig } from '@mention/shared-types';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';

export interface ThreadSlicingOptions {
  enableThreadGrouping: boolean;
  enableReplyContext: boolean;
  maxSliceSize: number; // max posts per slice (default 3)
  viewerId?: string;
}

interface RawPost {
  _id: any;
  id?: string;
  oxyUserId?: string;
  parentPostId?: string;
  threadId?: string;
  createdAt?: string | Date;
  user?: { id?: string; displayName?: string; handle?: string; avatarUrl?: string };
  [key: string]: any;
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
    for (const [parentId, parent] of parentPostMap.entries()) {
      if (!postById.has(parentId)) {
        additionalPostIds.push(parentId);
      }
    }

    // Build slices in feed order
    const slices: FeedPostSlice[] = [];

    for (const post of posts) {
      const postId = getPostId(post);

      // Skip if already consumed by a previous slice
      if (seenPostIds.has(postId)) continue;

      seenPostIds.add(postId);

      // Try self-thread grouping: root post with thread children by the same author
      if (opts.enableThreadGrouping && post.threadId && !post.parentPostId) {
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

      // Try reply context injection: if this post is a reply, prepend the parent
      if (opts.enableReplyContext && post.parentPostId) {
        const parentId = post.parentPostId;
        const parent = parentPostMap.get(parentId) || postById.get(parentId);

        if (parent && !seenPostIds.has(getPostId(parent))) {
          seenPostIds.add(getPostId(parent));

          const parentAuthor = parent.user || {
            id: parent.oxyUserId || '',
            handle: '',
            displayName: '',
          };

          slices.push(buildSlice([parent, post], true, {
            type: 'replyContext',
            parentAuthor: {
              id: parentAuthor.id || parent.oxyUserId || '',
              handle: parentAuthor.handle || '',
              displayName: parentAuthor.displayName || parentAuthor.handle || '',
              avatarUrl: parentAuthor.avatarUrl,
            },
          }));
          continue;
        }

        // Parent already shown or not found — still mark as reply context (incomplete)
        if (post.parentPostId) {
          slices.push(buildSlice([post], true));
          continue;
        }
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
        $or: orConditions,
      })
        .select('_id oxyUserId createdAt parentPostId threadId content stats metadata hashtags mentions language visibility type repostOf quoteOf')
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
      })
        .select('_id oxyUserId createdAt parentPostId threadId content stats metadata hashtags mentions language visibility type repostOf quoteOf')
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
  return post.id || post._id?.toString() || '';
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
    post: post as any, // will be hydrated later
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
