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
    // TODO: Implement once feed generator infrastructure is built
    logger.info('[FeedGeneratorFeed] peekLatest not yet implemented', { uri: this.generatorUri });
    return undefined;
  }

  async fetch(_options: FeedFetchOptions, _context: FeedContext): Promise<FeedAPIResponse> {
    // TODO: Look up FeedGenerator model, call its algorithm endpoint, hydrate results
    logger.info('[FeedGeneratorFeed] fetch not yet implemented', { uri: this.generatorUri });
    return {
      slices: [],
      items: [],
      hasMore: false,
      totalCount: 0,
    };
  }
}
