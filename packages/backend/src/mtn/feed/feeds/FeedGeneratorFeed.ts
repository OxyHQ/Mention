/**
 * Feed Generator Feed
 *
 * Third-party/user-created algorithmic feeds.
 * Looks up the FeedGenerator record and delegates to its algorithm.
 */

import { HydratedPost } from '@mention/shared-types';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext } from '../FeedAPI';
import { logger } from '../../../utils/logger';

export class FeedGeneratorFeed implements FeedAPI {
  readonly descriptor;
  private readonly generatorUri: string;

  constructor(generatorUri: string) {
    this.generatorUri = generatorUri;
    this.descriptor = `feedgen|${generatorUri}` as const;
  }

  async peekLatest(_context: FeedContext): Promise<HydratedPost | undefined> {
    // Stub: third-party feed-generator infrastructure (FeedGenerator model +
    // remote algorithm dereferencing) is not built yet, so this returns nothing.
    logger.info('[FeedGeneratorFeed] peekLatest not yet implemented', { uri: this.generatorUri });
    return undefined;
  }

  async fetch(_options: FeedFetchOptions, _context: FeedContext): Promise<FeedAPIResponse> {
    // Stub: until the FeedGenerator model + algorithm-endpoint dereferencing land,
    // a `feedgen|uri` descriptor resolves to an empty page instead of erroring.
    logger.info('[FeedGeneratorFeed] fetch not yet implemented', { uri: this.generatorUri });
    return {
      slices: [],
      items: [],
      hasMore: false,
      totalCount: 0,
    };
  }
}
