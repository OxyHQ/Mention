/**
 * MTN Feed Descriptor Type System
 *
 * Type-safe, parseable identifiers for feed sources.
 * Replaces the loose FeedType string union.
 */

/**
 * The tabs a profile feed can be sliced by. Each maps 1:1 to a tab on the
 * profile screen, so every one of them must resolve to an author feed —
 * `author|<oxyUserId>|<filter>`.
 */
export type AuthorFeedFilter = 'posts' | 'replies' | 'media' | 'videos' | 'likes' | 'boosts';

/** {@link AuthorFeedFilter} as a runtime list, in profile-tab order. */
export const AUTHOR_FEED_FILTERS: readonly AuthorFeedFilter[] = [
  'posts',
  'replies',
  'media',
  'videos',
  'likes',
  'boosts',
];

/** Narrow an arbitrary string to an {@link AuthorFeedFilter}. */
export function isAuthorFeedFilter(value: string | undefined): value is AuthorFeedFilter {
  return value !== undefined && (AUTHOR_FEED_FILTERS as readonly string[]).includes(value);
}

export type FeedDescriptor =
  | 'following'
  | 'for_you'
  | 'explore'
  | 'videos'
  | 'media'
  | 'saved'
  | 'trending'
  | 'mutuals'
  | 'friends_popular'
  | 'friends_of_friends'
  | `author|${string}`
  | `author|${string}|${AuthorFeedFilter}`
  | `custom|${string}`
  | `hashtag|${string}`
  | `topic|${string}`
  | `trend|${string}`
  | `list|${string}`
  | `feedgen|${string}`;

export type FeedDescriptorSource =
  | 'following'
  | 'for_you'
  | 'explore'
  | 'videos'
  | 'media'
  | 'saved'
  | 'trending'
  | 'mutuals'
  | 'friends_popular'
  | 'friends_of_friends'
  | 'author'
  | 'custom'
  | 'hashtag'
  | 'topic'
  | 'trend'
  | 'list'
  | 'feedgen';

export interface ParsedFeedDescriptor {
  source: FeedDescriptorSource;
  params: string[];
}

/**
 * Parse a feed descriptor string into its source and parameters.
 */
export function parseFeedDescriptor(descriptor: FeedDescriptor): ParsedFeedDescriptor {
  const parts = descriptor.split('|');
  const source = parts[0] as FeedDescriptorSource;
  const params = parts.slice(1);
  return { source, params };
}

/**
 * Build a feed descriptor from source and params.
 */
export function buildFeedDescriptor(source: FeedDescriptorSource, ...params: string[]): FeedDescriptor {
  const descriptor = params.length === 0
    ? source
    : `${source}|${params.join('|')}`;
  if (!isValidFeedDescriptor(descriptor)) {
    throw new Error(`Invalid feed descriptor: ${descriptor}`);
  }
  return descriptor;
}

/**
 * Check whether a string is a valid feed descriptor.
 */
export function isValidFeedDescriptor(value: string): value is FeedDescriptor {
  const simpleSources: ReadonlySet<FeedDescriptorSource> = new Set([
    'following', 'for_you', 'explore', 'videos', 'media', 'saved',
    'trending', 'mutuals', 'friends_popular', 'friends_of_friends',
  ]);
  const [source, ...params] = value.split('|');

  if (simpleSources.has(source as FeedDescriptorSource)) {
    return params.length === 0;
  }
  if (source === 'author') {
    return (
      (params.length === 1 || params.length === 2) &&
      isNonEmptyParam(params[0]) &&
      (params.length === 1 || isAuthorFeedFilter(params[1]))
    );
  }
  // `trend` takes a term that may legitimately contain spaces (`trend|todd
  // blanche`), which the `|`-delimited split leaves in one param untouched.
  if (['custom', 'hashtag', 'topic', 'trend', 'list', 'feedgen'].includes(source)) {
    return params.length === 1 && isNonEmptyParam(params[0]);
  }
  return false;
}

function isNonEmptyParam(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
