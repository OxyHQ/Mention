/**
 * Feed Response Builder
 * Centralized response building with consistent error handling and cursor management
 */

import { FeedResponse, HydratedPost } from '@mention/shared-types';
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

    // Deduplicate posts before transformation
    const deduplicatedPosts = deduplicatePosts(posts);

    // Check if there are more posts after deduplication
    const hasMore = deduplicatedPosts.length > limit;
    const postsToReturn = hasMore ? deduplicatedPosts.slice(0, limit) : deduplicatedPosts;

    // Calculate cursor BEFORE transformation using the actual last post that will be returned
    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      const lastPost = postsToReturn[postsToReturn.length - 1];
      nextCursor = buildFeedCursor(lastPost);

      // Validate cursor advanced (prevent infinite loops)
      if (previousCursor && nextCursor && !validateCursorAdvanced(nextCursor, previousCursor)) {
        logger.warn('⚠️ Cursor did not advance, stopping pagination', {
          previousCursor,
          nextCursor
        });
        nextCursor = undefined;
      }
    }

    // Transform posts if transformer provided
    let transformedPosts: HydratedPost[];
    if (transformPosts) {
      try {
        transformedPosts = await transformPosts(postsToReturn, currentUserId);
      } catch (error) {
        logger.error('[FeedResponseBuilder] Error transforming posts', error);
        // Return empty array instead of throwing to prevent feed from breaking
        transformedPosts = [];
      }
    } else {
      transformedPosts = postsToReturn as HydratedPost[];
    }

    // Final deduplication after transformation (transformation shouldn't create duplicates, but safety check)
    const finalUniquePosts = deduplicatePosts(transformedPosts);

    // Recalculate hasMore based on final deduplicated count
    const finalHasMore = finalUniquePosts.length >= limit && nextCursor !== undefined;

    // Final cursor validation
    let finalCursor = nextCursor;
    if (finalCursor && previousCursor && !validateCursorAdvanced(finalCursor, previousCursor)) {
      logger.warn('⚠️ Cursor did not advance after transformation, stopping pagination', {
        previousCursor,
        finalCursor
      });
      finalCursor = undefined;
    }

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






