/**
 * Feed Strategy Interface
 * Defines the contract for different feed generation strategies
 */

import { FeedResponse } from '@mention/shared-types';
import { AuthRequest } from '../../types/auth';

export interface FeedStrategyContext {
  currentUserId?: string;
  followingIds?: string[];
  userBehavior?: any;
  feedSettings?: any;
}

export interface FeedStrategyOptions {
  cursor?: string;
  limit: number;
  filters?: Record<string, unknown>;
}

/**
 * Base interface for feed strategies
 */
export interface IFeedStrategy {
  /**
   * Generate feed for the strategy
   */
  generateFeed(
    req: AuthRequest,
    options: FeedStrategyOptions,
    context: FeedStrategyContext
  ): Promise<FeedResponse>;
  
  /**
   * Get strategy name
   */
  getName(): string;
}












