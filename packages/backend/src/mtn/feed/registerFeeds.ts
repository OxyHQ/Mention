/**
 * Register all feed implementations with the FeedAPI registry.
 * Called once at server startup.
 */

import { feedAPIRegistry } from './FeedAPIRegistry';
import { FollowingFeed } from './feeds/FollowingFeed';
import { ForYouFeed } from './feeds/ForYouFeed';
import { ExploreFeed } from './feeds/ExploreFeed';
import { CustomFeed } from './feeds/CustomFeed';
import { AuthorFeed } from './feeds/AuthorFeed';
import { HashtagFeed } from './feeds/HashtagFeed';
import { ListFeed } from './feeds/ListFeed';
import { SavedFeed } from './feeds/SavedFeed';
import { FeedGeneratorFeed } from './feeds/FeedGeneratorFeed';
import type { AuthorFeedFilter } from '@mention/shared-types';

export function registerAllFeeds(): void {
  feedAPIRegistry.register('following', () => new FollowingFeed());
  feedAPIRegistry.register('for_you', () => new ForYouFeed());
  feedAPIRegistry.register('explore', () => new ExploreFeed());
  feedAPIRegistry.register('saved', () => new SavedFeed());

  feedAPIRegistry.register('custom', (params) => {
    const feedId = params[0];
    return new CustomFeed(feedId);
  });

  feedAPIRegistry.register('author', (params) => {
    const authorId = params[0];
    const filter = (params[1] || 'posts') as AuthorFeedFilter;
    return new AuthorFeed(authorId, filter);
  });

  feedAPIRegistry.register('hashtag', (params) => {
    const tag = params[0];
    return new HashtagFeed(tag);
  });

  feedAPIRegistry.register('list', (params) => {
    const listId = params[0];
    return new ListFeed(listId);
  });

  feedAPIRegistry.register('feedgen', (params) => {
    const generatorUri = params[0];
    return new FeedGeneratorFeed(generatorUri);
  });
}
