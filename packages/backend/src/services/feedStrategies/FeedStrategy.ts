/**
 * Feed Strategy Interface
 * Defines the contract for different feed generation strategies
 */

import { FeedResponse, SlicedFeedResponse } from '@mention/shared-types';
import { AuthRequest } from '../../types/auth';
import { OxyClient } from '../../utils/privacyHelpers';

export interface FeedStrategyContext {
  currentUserId?: string;
  followingIds?: string[];
  userBehavior?: any;
  feedSettings?: any;
  oxyClient?: OxyClient;
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
   * Generate feed for the strategy.
   * May return SlicedFeedResponse (with slices) or plain FeedResponse (backward compat).
   */
  generateFeed(
    req: AuthRequest,
    options: FeedStrategyOptions,
    context: FeedStrategyContext
  ): Promise<FeedResponse | SlicedFeedResponse>;

  /**
   * Get strategy name
   */
  getName(): string;
}













