/**
 * Feed Response Builder
 * Centralized response building with consistent error handling and cursor management
 */

import { FeedResponse, FeedPostSlice, HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import mongoose from 'mongoose';
import { buildFeedCursor, validateCursorAdvanced, deduplicatePosts, validateResultSize } from './feedUtils';
import { logger } from './logger';

/**
 * Raw feed post document (lean or hydrated Mongo result) before
 * hydration/transformation. Only the identity fields the builder reads are
 * declared; concrete Post documents are structurally assignable.
 */
export interface RawFeedPost {
  _id?: string | mongoose.Types.ObjectId;
  id?: string;
}

export interface FeedResponseOptions {
  posts: RawFeedPost[];
  limit: number;
  previousCursor?: string;
  transformPosts?: (posts: RawFeedPost[], currentUserId?: string) => Promise<HydratedPost[]>;
  currentUserId?: string;
  validateSize?: boolean;
}

export class FeedResponseBuilder {
  /**
   * Flatten feed slices into the flat `items` array every sliced response also
   * carries. Use this any time a post-fetch tuner mutates `slices`, so `items`
   * never keeps a post that was removed from the sliced response.
   */
  static flattenSlicesToItems(slices: FeedPostSlice[]): HydratedPost[] {
    const items: HydratedPost[] = [];
    for (const slice of slices) {
      for (const item of slice.items) {
        items.push(item.post as HydratedPost);
      }
    }
    return items;
  }

  /**
   * Build feed response with consistent deduplication, cursor handling, and transformation
   */
  static async buildResponse(options: FeedResponseOptions): Promise<FeedResponse> {
    const {
      posts,
      limit,
      previousCursor,
      transformPosts,
      currentUserId,
      validateSize = true
    } = options;

    // Validate result size if requested
    if (validateSize) {
      validateResultSize(posts, limit + 1);
    }

    // Check if there are more posts BEFORE deduplication (based on raw query result)
    // This prevents premature pagination end when dedup removes posts
    const hasMoreFromQuery = posts.length > limit;

    // Deduplicate posts before transformation
    const deduplicatedPosts = deduplicatePosts(posts);

    // Use query-based hasMore to avoid cursor stall when dedup removes posts
    const hasMore = hasMoreFromQuery || deduplicatedPosts.length > limit;
    const postsToReturn = deduplicatedPosts.length > limit ? deduplicatedPosts.slice(0, limit) : deduplicatedPosts;

    // Transform posts if transformer provided
    let transformedPosts: HydratedPost[];
    if (transformPosts) {
      try {
        transformedPosts = await transformPosts(postsToReturn, currentUserId);
      } catch (error) {
        logger.error('[FeedResponseBuilder] Error transforming posts, returning raw posts', error);
        // Return raw posts instead of empty array to preserve data
        transformedPosts = postsToReturn.map(post => ({
          ...post,
          id: (post._id != null ? String(post._id) : undefined) ?? post.id,
          _transformError: true, // Flag to indicate transformation failed
        })) as unknown as HydratedPost[];
      }
    } else {
      transformedPosts = postsToReturn as unknown as HydratedPost[];
    }

    // Final deduplication after transformation
    const finalUniquePosts = deduplicatePosts(transformedPosts);

    // Calculate cursor AFTER transformation using the final set's last post
    let finalCursor: string | undefined;
    if (finalUniquePosts.length > 0 && hasMore) {
      const lastPost = finalUniquePosts[finalUniquePosts.length - 1];
      finalCursor = buildFeedCursor(lastPost);

      // Validate cursor advanced (prevent infinite loops)
      if (previousCursor && finalCursor && !validateCursorAdvanced(finalCursor, previousCursor)) {
        logger.warn('⚠️ Cursor did not advance, stopping pagination', {
          previousCursor,
          finalCursor
        });
        finalCursor = undefined;
      }
    }

    const finalHasMore = finalUniquePosts.length >= limit && finalCursor !== undefined;

    return {
      items: finalUniquePosts,
      hasMore: finalHasMore,
      nextCursor: finalCursor,
      totalCount: finalUniquePosts.length
    };
  }

  /**
   * Build sliced feed response from hydrated slices.
   * Populates `slices` (the thread-grouped representation) and the flat `items`
   * mirror every client's flat-render path reads.
   */
  static buildSlicedResponse(options: {
    slices: FeedPostSlice[];
    limit: number;
    previousCursor?: string;
    cursorFromLastSlice?: string;
    hasMore?: boolean; // caller-provided hasMore (from post overfetch check)
  }): SlicedFeedResponse {
    const { slices, limit, previousCursor, cursorFromLastSlice } = options;

    // hasMore is determined by the caller (who checks post count vs overfetch),
    // not by comparing slice count to post limit (they measure different things).
    const hasMore = options.hasMore ?? slices.length > limit;
    const slicesToReturn = slices;

    const items = FeedResponseBuilder.flattenSlicesToItems(slicesToReturn);

    // Calculate cursor from last slice's anchor post (first post in the slice)
    let nextCursor: string | undefined;
    if (slicesToReturn.length > 0 && hasMore) {
      if (cursorFromLastSlice) {
        nextCursor = cursorFromLastSlice;
      } else {
        // Default: use last slice's first post ID as cursor
        const lastSlice = slicesToReturn[slicesToReturn.length - 1];
        const anchorPost = lastSlice.items[0]?.post;
        if (anchorPost?.id) {
          nextCursor = anchorPost.id;
        }
      }

      // Validate cursor advanced
      if (previousCursor && nextCursor && !validateCursorAdvanced(nextCursor, previousCursor)) {
        logger.warn('[FeedResponseBuilder] Sliced cursor did not advance', {
          previousCursor,
          nextCursor,
        });
        nextCursor = undefined;
      }
    }

    return {
      slices: slicesToReturn,
      items,
      // `hasMore` is the caller's authoritative post-overfetch result (resolved
      // into the `hasMore` const above), NOT a slice-count comparison. Slices are
      // post GROUPS produced by thread slicing, so `slicesToReturn.length` is
      // always <= the post count and routinely drops below `limit` whenever any
      // thread is grouped (e.g. explore returns 18 slices for 20 posts). Gating on
      // `slicesToReturn.length >= limit` therefore reported `hasMore: false` on a
      // full page that has more data — stalling infinite scroll after page 1. The
      // real precondition for "there is more" is simply a valid advancing cursor.
      hasMore: hasMore && nextCursor !== undefined,
      nextCursor,
      totalCount: items.length,
    };
  }

  /**
   * Build empty response
   */
  static buildEmptyResponse(): FeedResponse {
    return {
      items: [],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 0
    };
  }
}













