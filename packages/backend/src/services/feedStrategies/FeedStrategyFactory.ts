/**
 * Feed Strategy Factory
 * Creates appropriate feed strategy based on feed type
 */

import { FeedType } from '@mention/shared-types';
import { IFeedStrategy } from './FeedStrategy';
import { ForYouFeedStrategy } from './ForYouFeedStrategy';

export class FeedStrategyFactory {
  private static strategies: Map<FeedType, IFeedStrategy> = new Map();
  
  static {
    // Register strategies
    this.strategies.set('for_you', new ForYouFeedStrategy());
    // Add more strategies as needed
    // this.strategies.set('following', new FollowingFeedStrategy());
    // this.strategies.set('explore', new ExploreFeedStrategy());
  }
  
  /**
   * Get strategy for feed type
   */
  static getStrategy(feedType: FeedType): IFeedStrategy | null {
    return this.strategies.get(feedType) || null;
  }
  
  /**
   * Register a new strategy
   */
  static registerStrategy(feedType: FeedType, strategy: IFeedStrategy): void {
    this.strategies.set(feedType, strategy);
  }
}






