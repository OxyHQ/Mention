/**
 * Descriptor → FeedDefinition resolution.
 *
 * Replaces `FeedAPIRegistry.resolve`: parse the descriptor and return the
 * matching built-in / parameterized {@link FeedDefinition}, or `null` for
 * descriptors the engine does not own in Phase 1 (`custom|id` keeps the legacy
 * CustomFeed path; `feedgen|uri` keeps the external stub — both branched in the
 * controller).
 */

import { parseFeedDescriptor } from '@mention/shared-types';
import type { FeedDescriptor, AuthorFeedFilter } from '@mention/shared-types';
import type { FeedDefinition } from '../engine/types';
import {
  forYouDefinition,
  followingDefinition,
  exploreDefinition,
  videosDefinition,
  mediaDefinition,
  savedDefinition,
  authorDefinition,
  hashtagDefinition,
  topicDefinition,
  listDefinition,
} from './presets';

const AUTHOR_FILTERS: readonly AuthorFeedFilter[] = ['posts', 'replies', 'media', 'likes'];

export function resolveDefinition(descriptor: FeedDescriptor): FeedDefinition | null {
  const { source, params } = parseFeedDescriptor(descriptor);

  switch (source) {
    case 'for_you':
      return forYouDefinition;
    case 'following':
      return followingDefinition;
    case 'explore':
      return exploreDefinition;
    case 'videos':
      return videosDefinition;
    case 'media':
      return mediaDefinition;
    case 'saved':
      return savedDefinition;
    case 'author': {
      const authorId = params[0];
      if (!authorId) return null;
      const filter = AUTHOR_FILTERS.includes(params[1] as AuthorFeedFilter)
        ? (params[1] as AuthorFeedFilter)
        : 'posts';
      return authorDefinition(authorId, filter);
    }
    case 'hashtag': {
      const tag = params[0];
      return tag ? hashtagDefinition(tag) : null;
    }
    case 'topic': {
      const slug = params[0];
      return slug ? topicDefinition(slug) : null;
    }
    case 'list': {
      const listId = params[0];
      return listId ? listDefinition(listId) : null;
    }
    // custom|id and feedgen|uri are not engine-owned in Phase 1.
    case 'custom':
    case 'feedgen':
      return null;
    default:
      return null;
  }
}
