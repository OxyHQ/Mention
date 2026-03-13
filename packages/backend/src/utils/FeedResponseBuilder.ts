/**
 * Feed Response Builder
 * Centralized response building with consistent error handling and cursor management
 */

import { FeedResponse, FeedPostSlice, HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import mongoose from 'mongoose';
import { buildFeedCursor, validateCursorAdvanced, deduplicatePosts, validateResultSize } from './feedUtils';
import { logger } from './logger';

export interface FeedResponseOptions {
  posts: any[];
  limit: number;
  previousCursor?: string;
  transformPosts?: (posts: any[], currentUserId?: string) => Promise<HydratedPost[]>;
  currentUserId?: string;
  validateSize?: boolean;
}

export class FeedResponseBuilder {
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
          id: post._id?.toString() || post.id,
          _transformError: true, // Flag to indicate transformation failed
        })) as HydratedPost[];
      }
    } else {
      transformedPosts = postsToReturn as HydratedPost[];
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
   * Build response for saved posts with special handling
   */
  static async buildSavedPostsResponse(
    posts: any[],
    limit: number,
    previousCursor?: string,
    transformPosts?: (posts: any[], currentUserId?: string) => Promise<HydratedPost[]>,
    currentUserId?: string
  ): Promise<FeedResponse> {
    // For saved posts, mark all posts as saved after transformation
    const response = await this.buildResponse({
      posts,
      limit,
      previousCursor,
      transformPosts: async (postsToTransform, userId) => {
        const transformed = transformPosts
          ? await transformPosts(postsToTransform, userId)
          : (postsToTransform as HydratedPost[]);

        // Mark all posts as saved
        transformed.forEach((post: any) => {
          post.isSaved = true;
          if (post.metadata) {
            post.metadata.isSaved = true;
          } else {
            post.metadata = { isSaved: true };
          }
        });

        return transformed;
      },
      currentUserId,
      validateSize: true
    });

    return response;
  }

  /**
   * Build sliced feed response from hydrated slices.
   * Populates both `slices` (for new clients) and `items` (backward compat).
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

    // Flatten slices into items for backward compatibility
    const items: HydratedPost[] = [];
    for (const slice of slicesToReturn) {
      for (const item of slice.items) {
        items.push(item.post as HydratedPost);
      }
    }

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
      hasMore: slicesToReturn.length >= limit && nextCursor !== undefined,
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













