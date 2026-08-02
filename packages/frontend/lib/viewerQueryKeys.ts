import type { QueryClient } from '@tanstack/react-query';

export type ViewerId = string | null | undefined;

const ANONYMOUS_VIEWER = 'anon';
const PUBLIC_ROOT = ['mention', 'public'] as const;

export function viewerCacheId(viewerId: ViewerId): string {
  const normalized = viewerId?.trim();
  return normalized ? normalized : ANONYMOUS_VIEWER;
}

/**
 * Mention-owned data that is identical for every caller. Canonical Oxy identity
 * objects are intentionally not duplicated here: callers must use
 * `@oxyhq/services`' `queryKeys.users.*` for those public identity records only.
 */
export const publicQueryKeys = {
  all: () => PUBLIC_ROOT,
  customFeedReviews: (feedId: string) => [
    ...PUBLIC_ROOT,
    'custom-feed-reviews',
    feedId,
  ] as const,
  externalActorResolve: (query: string) => [
    ...PUBLIC_ROOT,
    'external-actor-resolve',
    query,
  ] as const,
  feedModules: () => [...PUBLIC_ROOT, 'feed-modules'] as const,
  marketplaceCategories: () => [
    ...PUBLIC_ROOT,
    'marketplace-categories',
  ] as const,
  trendingHistory: () => [...PUBLIC_ROOT, 'trending-history'] as const,
  /**
   * The generated summary of one trend, keyed by its TERM (the stable identity)
   * rather than by its label, which can change between runs.
   */
  trendSummary: (term: string) => [...PUBLIC_ROOT, 'trend-summary', term] as const,
};

/**
 * Every response whose shape or visibility can depend on the signed-in viewer
 * starts with this prefix. Besides preventing A/B cache collisions, the prefix
 * gives account transitions one precise namespace to cancel and remove.
 */
export const viewerQueryKeys = {
  all: (viewerId: ViewerId) => ['viewer', viewerCacheId(viewerId)] as const,
  postsRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'posts',
  ] as const,
  post: (viewerId: ViewerId, postId: string) => [
    ...viewerQueryKeys.postsRoot(viewerId),
    'detail',
    postId,
  ] as const,
  pinnedPost: (viewerId: ViewerId, profileId: string) => [
    ...viewerQueryKeys.postsRoot(viewerId),
    'pinned',
    profileId,
  ] as const,
  /**
   * The viewer's own not-yet-published scheduled posts. Strictly private: the
   * list is the caller's alone, so it can never be shared across viewers the way
   * a public post detail can.
   */
  scheduledPosts: (viewerId: ViewerId) => [
    ...viewerQueryKeys.postsRoot(viewerId),
    'scheduled',
  ] as const,
  feedsRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'feeds',
  ] as const,
  feed: (
    viewerId: ViewerId,
    type: string,
    filters?: Readonly<Record<string, unknown>>,
  ) => [
    ...viewerQueryKeys.feedsRoot(viewerId),
    type,
    filters,
  ] as const,
  search: (
    viewerId: ViewerId,
    tab: string,
    query: string,
    canUsePrivateApi: boolean,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'search',
    tab,
    query,
    canUsePrivateApi,
  ] as const,
  searchHistory: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'search-history',
  ] as const,
  livePresence: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'live-presence',
  ] as const,
  savedPostsRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'saved-posts',
  ] as const,
  savedPosts: (
    viewerId: ViewerId,
    search: string,
    folder: string | null,
  ) => [
    ...viewerQueryKeys.savedPostsRoot(viewerId),
    search,
    folder ?? 'all',
  ] as const,
  bookmarkFolders: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'bookmark-folders',
  ] as const,
  listsRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'lists',
  ] as const,
  ownedLists: (viewerId: ViewerId) => [
    ...viewerQueryKeys.listsRoot(viewerId),
    'owned',
  ] as const,
  followedLists: (viewerId: ViewerId) => [
    ...viewerQueryKeys.listsRoot(viewerId),
    'followed',
  ] as const,
  list: (viewerId: ViewerId, listId: string) => [
    ...viewerQueryKeys.listsRoot(viewerId),
    'detail',
    listId,
  ] as const,
  listMembers: (
    viewerId: ViewerId,
    listId: string,
    memberIds: readonly string[],
  ) => [
    ...viewerQueryKeys.list(viewerId, listId),
    'members',
    memberIds,
  ] as const,
  lanesRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'lanes',
  ] as const,
  /** The caller's own lanes, each with its current post count. */
  ownedLanes: (viewerId: ViewerId) => [
    ...viewerQueryKeys.lanesRoot(viewerId),
    'owned',
  ] as const,
  /** The lanes this reader has silenced, grouped by publisher. */
  mutedLanes: (viewerId: ViewerId) => [
    ...viewerQueryKeys.lanesRoot(viewerId),
    'muted',
  ] as const,
  /**
   * A publisher's lanes that HAVE a tab. Reader-agnostic on the server, but
   * keyed by viewer like every other private read so an account switch drops it
   * with the rest of the namespace.
   */
  lanesForOwner: (
    viewerId: ViewerId,
    ownerType: string,
    ownerId: string | null | undefined,
  ) => [
    ...viewerQueryKeys.lanesRoot(viewerId),
    'owner',
    ownerType,
    ownerId ?? '',
  ] as const,
  channelsRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'channels',
  ] as const,
  /**
   * The directory, keyed by viewer because a signed-in reader's page EXCLUDES the
   * channels they already follow — the same list is a different list per reader.
   */
  channelDirectory: (viewerId: ViewerId) => [
    ...viewerQueryKeys.channelsRoot(viewerId),
    'directory',
  ] as const,
  /**
   * ONE channel, keyed by whatever spelling the URL carried (id or handle) — the
   * backend resolves both, and keying by the raw segment keeps the page's own
   * fetch and its invalidations talking about the same thing.
   */
  channel: (viewerId: ViewerId, idOrHandle: string) => [
    ...viewerQueryKeys.channelsRoot(viewerId),
    'detail',
    idOrHandle,
  ] as const,
  channelMembers: (viewerId: ViewerId, idOrHandle: string) => [
    ...viewerQueryKeys.channel(viewerId, idOrHandle),
    'members',
  ] as const,
  /** The channels the caller may publish to. */
  ownedChannels: (viewerId: ViewerId) => [
    ...viewerQueryKeys.channelsRoot(viewerId),
    'mine',
  ] as const,
  /**
   * The channels the caller READS — a different question from `ownedChannels`,
   * backed by a different model (`ChannelFollow` rather than `ChannelMember`), so
   * a different key rather than a parameter on the same one.
   */
  followedChannels: (viewerId: ViewerId) => [
    ...viewerQueryKeys.channelsRoot(viewerId),
    'following',
  ] as const,
  /** Membership invitations awaiting the caller's answer. */
  channelInvites: (viewerId: ViewerId) => [
    ...viewerQueryKeys.channelsRoot(viewerId),
    'invites',
  ] as const,
  /**
   * Profiles matching a SUBMITTED search term on the owner's invite screen.
   *
   * Inside the channel namespace rather than a generic search one so a
   * membership write clears it along with everything else it invalidates — the
   * rows carry an "already invited" state that a stale result would keep
   * offering.
   */
  channelInviteSearch: (viewerId: ViewerId, term: string) => [
    ...viewerQueryKeys.channelsRoot(viewerId),
    'invite-search',
    term,
  ] as const,
  /**
   * A CHANNEL's lanes, as the composer offers them when publishing into it.
   *
   * `manage` is part of the key because the two reads answer DIFFERENT lists:
   * the owner's management view (`GET /lanes/mine?channelId=`) includes `mixed`
   * and `hidden` lanes, while a publisher can only read the public tab list. One
   * cached under the other would offer a publisher lanes the server never showed
   * them.
   */
  channelLanes: (viewerId: ViewerId, channelId: string, manage: boolean) => [
    ...viewerQueryKeys.channelsRoot(viewerId),
    'lanes',
    channelId,
    manage ? 'manage' : 'public',
  ] as const,
  /**
   * Readable names for the channels pinned as home tabs. Keyed by the id SET, so
   * pinning or unpinning one re-resolves the labels instead of serving a map that
   * is missing an entry.
   */
  channelTitles: (viewerId: ViewerId, channelIds: readonly string[]) => [
    ...viewerQueryKeys.channelsRoot(viewerId),
    'titles',
    channelIds,
  ] as const,
  pokesRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'pokes',
  ] as const,
  pokes: (
    viewerId: ViewerId,
    kind: 'received' | 'sent' | 'suggested',
  ) => [
    ...viewerQueryKeys.pokesRoot(viewerId),
    kind,
  ] as const,
  notificationsRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'notifications',
  ] as const,
  /** The viewer's activity subscriptions ("notify me when this account posts"). */
  subscriptions: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'activity-subscriptions',
  ] as const,
  notifications: (viewerId: ViewerId) => [
    ...viewerQueryKeys.notificationsRoot(viewerId),
    'list',
  ] as const,
  notificationActors: (viewerId: ViewerId, actorIds: readonly string[]) => [
    ...viewerQueryKeys.notificationsRoot(viewerId),
    'actors',
    actorIds,
  ] as const,
  unreadNotifications: (viewerId: ViewerId) => [
    ...viewerQueryKeys.notificationsRoot(viewerId),
    'unread-count',
  ] as const,
  similarProfiles: (
    viewerId: ViewerId,
    sourceUserId: string | null | undefined,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'similar-profiles',
    sourceUserId ?? '',
  ] as const,
  mutualFollowers: (viewerId: ViewerId, profileId: string | null | undefined) => [
    ...viewerQueryKeys.all(viewerId),
    'mutual-followers',
    profileId ?? '',
  ] as const,
  knownLikers: (viewerId: ViewerId, postId: string | null | undefined) => [
    ...viewerQueryKeys.all(viewerId),
    'known-likers',
    postId ?? '',
  ] as const,
  connectionsMutuals: (
    viewerId: ViewerId,
    profileId: string | null | undefined,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'connections-mutuals',
    profileId ?? '',
  ] as const,
  customFeedsRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'custom-feeds',
  ] as const,
  customFeedTitles: (viewerId: ViewerId) => [
    ...viewerQueryKeys.customFeedsRoot(viewerId),
    'titles',
  ] as const,
  customFeed: (viewerId: ViewerId, feedId: string) => [
    ...viewerQueryKeys.customFeedsRoot(viewerId),
    'detail',
    feedId,
  ] as const,
  customFeedMarketplace: (
    viewerId: ViewerId,
    filters: Readonly<Record<string, unknown>>,
  ) => [
    ...viewerQueryKeys.customFeedsRoot(viewerId),
    'marketplace',
    filters,
  ] as const,
  feedInterstitial: (
    viewerId: ViewerId,
    kind: 'suggested-feeds' | 'suggested-starter-packs',
    subjectId?: string,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'feed-interstitial',
    kind,
    subjectId ?? '',
  ] as const,
  starterPacksMine: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'starter-packs',
    'mine',
  ] as const,
  connectedAi: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'connected-ai',
  ] as const,
  interestsCategories: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'interests-categories',
  ] as const,
  myAppearance: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'appearance',
    'mine',
  ] as const,
  appearanceForUser: (viewerId: ViewerId, userId: string) => [
    ...viewerQueryKeys.all(viewerId),
    'appearance',
    'user',
    userId,
  ] as const,
  muteWords: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'mute-words',
  ] as const,
  feedPreferences: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'feed-preferences',
  ] as const,
  feedTuning: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'feed-tuning',
  ] as const,
  feedSettings: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'feed-settings',
  ] as const,
  labelers: (viewerId: ViewerId, search: string) => [
    ...viewerQueryKeys.all(viewerId),
    'labelers',
    search,
  ] as const,
  postInsights: (viewerId: ViewerId, postId: string) => [
    ...viewerQueryKeys.all(viewerId),
    'post-insights',
    postId,
  ] as const,
  profileFeeds: (
    viewerId: ViewerId,
    profileId: string | null | undefined,
    isOwnProfile: boolean,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'profile-feeds',
    profileId ?? '',
    isOwnProfile,
  ] as const,
  profileStarterPacks: (
    viewerId: ViewerId,
    profileId: string | null | undefined,
    isOwnProfile: boolean,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'profile-starter-packs',
    profileId ?? '',
    isOwnProfile,
  ] as const,
  profileLists: (
    viewerId: ViewerId,
    profileId: string | null | undefined,
    isOwnProfile: boolean,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'profile-lists',
    profileId ?? '',
    isOwnProfile,
  ] as const,
  weeklyRecap: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'weekly-recap',
  ] as const,
  insights: (viewerId: ViewerId, period: string | number) => [
    ...viewerQueryKeys.all(viewerId),
    'insights',
    period,
  ] as const,
  recommendationFilters: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'recommendation-filters',
  ] as const,
  recommendations: (viewerId: ViewerId, excludeTypesCsv: string) => [
    ...viewerQueryKeys.all(viewerId),
    'recommendations',
    excludeTypesCsv,
  ] as const,
  infiniteRecommendations: (viewerId: ViewerId, excludeTypesCsv: string) => [
    ...viewerQueryKeys.all(viewerId),
    'recommendations',
    'infinite',
    excludeTypesCsv,
  ] as const,
  viewerFollowing: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'following',
  ] as const,
  postActivity: (viewerId: ViewerId, userId: string | null | undefined) => [
    ...viewerQueryKeys.all(viewerId),
    'post-activity',
    userId ?? '',
  ] as const,
  mentionNode: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'mention-node',
  ] as const,
  federatedProfile: (viewerId: ViewerId, handle: string) => [
    ...viewerQueryKeys.all(viewerId),
    'federated-profile',
    handle,
  ] as const,
  liveUsers: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'live-users',
  ] as const,
  profileMediaSearch: (
    viewerId: ViewerId,
    type: string,
    query: string,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'profile-media-search',
    type,
    query,
  ] as const,
  isFamily: (queryKey: readonly unknown[], family: string): boolean =>
    queryKey[0] === 'viewer' && queryKey[2] === family,
  isAppearanceForUser: (
    queryKey: readonly unknown[],
    userId: string,
  ): boolean =>
    viewerQueryKeys.isFamily(queryKey, 'appearance') &&
    queryKey[3] === 'user' &&
    queryKey[4] === userId,
};

/** The single factory for every Mention-owned React Query key. */
export const mentionQueryKeys = {
  public: publicQueryKeys,
  private: viewerQueryKeys,
} as const;

export function viewerStorageKey(baseKey: string, viewerId: ViewerId): string {
  return `${baseKey}:${encodeURIComponent(viewerCacheId(viewerId))}`;
}

/**
 * Remove only the previous viewer's private namespace. The next viewer has a
 * different prefix, so an in-flight response from A can never populate B's key.
 */
export async function clearViewerQueryCache(
  queryClient: QueryClient,
  viewerId: string,
): Promise<void> {
  const queryKey = viewerQueryKeys.all(viewerId);
  await queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
}
