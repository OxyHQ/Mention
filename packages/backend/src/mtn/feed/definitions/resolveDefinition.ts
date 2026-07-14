/**
 * Descriptor → FeedDefinition resolution.
 *
 * Replaces `FeedAPIRegistry.resolve`: parse the descriptor and return the
 * matching built-in / parameterized {@link FeedDefinition}. `custom|<id>` loads
 * the viewer's stored CustomFeed definition (owner/visibility checked) via the
 * viewer context; `feedgen|uri` stays the external stub (branched in the
 * controller). Returns `null` for descriptors it does not own.
 *
 * Async because the custom branch reads the CustomFeed document; the built-in
 * branches resolve synchronously.
 */

import { isAuthorFeedFilter, parseFeedDescriptor } from '@mention/shared-types';
import type { FeedDescriptor } from '@mention/shared-types';
import type { FeedDefinition } from '../engine/types';
import { loadCustomFeedDefinition } from './customFeedDefinition';
import {
  forYouDefinition,
  followingDefinition,
  exploreDefinition,
  videosDefinition,
  mediaDefinition,
  savedDefinition,
  trendingDefinition,
  mutualsDefinition,
  friendsPopularDefinition,
  friendsOfFriendsDefinition,
  authorDefinition,
  hashtagDefinition,
  topicDefinition,
  listDefinition,
} from './presets';

/** Viewer context needed to resolve viewer-scoped descriptors (custom feeds). */
export interface ResolveDefinitionContext {
  currentUserId?: string;
}

export async function resolveDefinition(
  descriptor: FeedDescriptor,
  ctx?: ResolveDefinitionContext,
): Promise<FeedDefinition | null> {
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
    case 'trending':
      return trendingDefinition;
    case 'mutuals':
      return mutualsDefinition;
    case 'friends_popular':
      return friendsPopularDefinition;
    case 'friends_of_friends':
      return friendsOfFriendsDefinition;
    case 'author': {
      const authorId = params[0];
      if (!authorId) return null;
      // An unknown/absent filter degrades to the default profile tab rather than
      // 404ing, so a stale client can never break a profile.
      const filter = isAuthorFeedFilter(params[1]) ? params[1] : 'posts';
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
    case 'custom':
      // Viewer-scoped: needs a context to owner/visibility-check the stored feed.
      return ctx ? loadCustomFeedDefinition(params[0], ctx.currentUserId) : null;
    // feedgen|uri stays the external stub, branched in the controller.
    case 'feedgen':
      return null;
    default:
      return null;
  }
}
