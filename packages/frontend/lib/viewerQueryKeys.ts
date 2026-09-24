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
 * `@oxy.so/services`' `queryKeys.users.*` for those public identity records only.
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
  /**
   * Who the profile links pasted into one composer body name — one key for the
   * whole batch, because the endpoint answers for a body's links in one request.
   *
   * Sorted, so the same set of links keyed in a different reading order is the
   * same cached answer; joined on a newline, which no URL can contain, so two
   * different sets can never collide into one key.
   *
   * Public: the answer is the same for every author, and it is the same lookup
   * the server does when it decides whether those links become real mentions.
   */
  profileLinkMentions: (urls: readonly string[]) =>
    [...PUBLIC_ROOT, 'profile-link-mentions', [...urls].sort().join('\n')] as const,
  marketplaceCategories: () => [
    ...PUBLIC_ROOT,
    'marketplace-categories',
  ] as const,
  /**
   * One post's correction trail. Public because the endpoint is: a publication's
   * corrections are addressed to whoever read the post, so the answer does not
   * depend on who is asking and two readers must not hold separate copies of it.
   */
  postCorrections: (postId: string) => [
    ...PUBLIC_ROOT,
    'post-corrections',
    postId,
  ] as const,
  /**
   * The topic catalogue behind the interests picker — the default grid when the
   * search box is empty, and the matches for a query otherwise.
   *
   * Public, and keyed only on the query: `/topics` is mounted on the public API
   * and the catalogue is the same for every reader. What the VIEWER follows out
   * of it is a separate, viewer-scoped key.
   */
  topicCatalogue: (query: string) => [...PUBLIC_ROOT, 'topic-catalogue', query] as const,
  trendingHistory: () => [...PUBLIC_ROOT, 'trending-history'] as const,
  /**
   * The generated summary of one trend, keyed by its TERM (the stable identity)
   * rather than by its label, which can change between runs.
   */
  trendSummary: (term: string) => [...PUBLIC_ROOT, 'trend-summary', term] as const,
  /**
   * Keyed on BOTH filters: the server returns a different graph per scope, and
   * a shared key would show a reader the Spanish graph after they picked a
   * region and hand them stale edges that no longer connect anything visible.
   */
  trendGraph: (language: string | null, region: string | null) =>
    [...PUBLIC_ROOT, 'trend-graph', language ?? 'all', region ?? 'all'] as const,
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
  /**
   * A poll as THIS viewer sees it: the tallies are public, but
   * `viewerSelectedOptionIds` is the caller's own vote. One cached answer per
   * poll, so a feed that recycles the same poll row does not refetch it.
   */
  poll: (viewerId: ViewerId, pollId: string) => [
    ...viewerQueryKeys.postsRoot(viewerId),
    'poll',
    pollId,
  ] as const,
  pinnedPost: (viewerId: ViewerId, profileId: string) => [
    ...viewerQueryKeys.postsRoot(viewerId),
    'pinned',
    profileId,
  ] as const,
  /**
   * The not-yet-published posts this viewer can act on — their own, plus the
   * shared editorial queue of every channel they operate.
   *
   * Still strictly VIEWER-scoped, and the distinction matters: the entries are no
   * longer the caller's alone, but WHICH entries they are depends on the caller's
   * channel memberships, so this response can never be shared across viewers the
   * way a public post detail can. Two members of one channel see overlapping
   * lists that are not equal — each also holds their own posts — so keying on the
   * channel instead would serve one member the other's personal queue.
   */
  scheduledPosts: (viewerId: ViewerId) => [
    ...viewerQueryKeys.postsRoot(viewerId),
    'scheduled',
  ] as const,
  /**
   * Community notes, always viewer-scoped: every list here is "yours" — the
   * queue CrowdSource assigned to you, the notes you wrote, the ones you rated.
   * None of them may be shared across viewers, and the anonymous key is never
   * used because all four require a session.
   */
  communityNotesRoot: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'community-notes',
  ] as const,
  communityNotesAvailability: (viewerId: ViewerId) => [
    ...viewerQueryKeys.communityNotesRoot(viewerId),
    'availability',
  ] as const,
  communityNotesQueue: (viewerId: ViewerId) => [
    ...viewerQueryKeys.communityNotesRoot(viewerId),
    'to-rate',
  ] as const,
  communityNotesWritten: (viewerId: ViewerId) => [
    ...viewerQueryKeys.communityNotesRoot(viewerId),
    'written',
  ] as const,
  communityNotesRated: (viewerId: ViewerId) => [
    ...viewerQueryKeys.communityNotesRoot(viewerId),
    'rated',
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
    ownerId: string | null | undefined,
  ) => [
    ...viewerQueryKeys.lanesRoot(viewerId),
    'owner',
    ownerId ?? '',
  ] as const,
  /**
   * The lanes of ANOTHER account the caller operates — a channel account — as
   * that account's operator manages them.
   *
   * Separate from {@link ownedLanes} because it names a different account, and
   * from {@link lanesForOwner} because it answers a DIFFERENT list: the
   * management read (`GET /lanes/mine?ownerId=`) includes `mixed` and `hidden`
   * lanes, while the public read is the tab list only. One cached under the
   * other would offer lanes the server never showed.
   */
  operatedLanes: (viewerId: ViewerId, ownerId: string) => [
    ...viewerQueryKeys.lanesRoot(viewerId),
    'operated',
    ownerId,
  ] as const,
  /**
   * The Oxy accounts the caller operates, as the composer's "publish as" picker
   * reads them. One key for the whole account graph — the picker filters it down
   * to channel accounts itself, and a second key per kind would fan the same
   * request out twice.
   */
  operatedAccounts: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'accounts',
    'operated',
  ] as const,
  /**
   * The Mention-owned settings of ONE channel account, keyed by that account's
   * `oxyUserId` — not by the caller's, because a channel has no login of its own
   * and its operator reads it on its behalf.
   */
  channelAccountSettings: (viewerId: ViewerId, accountId: string) => [
    ...viewerQueryKeys.all(viewerId),
    'accounts',
    'channel-settings',
    accountId,
  ] as const,
  /**
   * The people ONE channel has already NAMED on its posts, keyed by that
   * channel's `oxyUserId`.
   *
   * Deliberately not under `accounts` beside {@link channelAccountSettings},
   * which is the operator's read of a preference. This is a public derived list
   * about the same account, and the two are invalidated by different events.
   *
   * Keyed by viewer for the reason {@link lanesForOwner} gives, plus a sharper
   * one: the server answers 404 both for a channel that does not name its
   * writers and for a RESTRICTED channel this reader may not see. Those two are
   * indistinguishable by design, and that refusal decides whether the tab
   * exists at all — so one viewer's 404 must never be served to another as the
   * absence of a tab.
   */
  channelWriters: (viewerId: ViewerId, channelId: string | null | undefined) => [
    ...viewerQueryKeys.all(viewerId),
    'channel-writers',
    channelId ?? '',
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
  profileReputation: (
    viewerId: ViewerId,
    profileId: string | null | undefined,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'profile-reputation',
    profileId ?? '',
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
  /**
   * `jobsService.getMine()` — every Mention job listing the caller can act on,
   * across every organization/project account they operate. One key for the
   * whole set (not per-status): the dashboard filters client-side, and a
   * status-scoped key would fan one create/publish/pause/close/duplicate
   * mutation out into several invalidations for what is really one list.
   */
  jobsMine: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'mine',
  ] as const,
  /**
   * `jobsService.searchPlaces({ q })` — the job form's location autocomplete.
   * Viewer-scoped because the route is authenticated, although the gazetteer
   * answer itself is the same for everyone.
   */
  jobPlaces: (viewerId: ViewerId, query: string) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'places',
    query,
  ] as const,
  /** One job by id or slug (`jobsService.get`) — the edit form and the public job page share this key. */
  jobDetail: (viewerId: ViewerId, idOrSlug: string) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'detail',
    idOrSlug,
  ] as const,
  /** `jobsService.getMetrics(id)` — the employer-only aggregate summary shown on the job's own edit screen. */
  jobMetrics: (viewerId: ViewerId, jobId: string) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'metrics',
    jobId,
  ] as const,
  /**
   * The employer's Oxy profile (`oxyServices.getUserById`), for the public
   * job page and the native-apply screen's "who you're applying to" link —
   * a plain identity lookup, not job data, but scoped alongside the other
   * `jobs` keys since both call sites reach it FROM a job.
   */
  jobEmployerProfile: (viewerId: ViewerId, employerOxyUserId: string | null | undefined) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'employer-profile',
    employerOxyUserId ?? '',
  ] as const,
  /**
   * `jobsService.list()` — the public Clarity-backed discovery screen
   * (`app/(app)/jobs/index.tsx`). Keyed by viewer anyway, like every other
   * private read (`search` above is the same shape of key for the same
   * reason): discovery itself needs no signed-in session, but the screen is
   * reached only from inside the authenticated app shell, and an account
   * switch should drop it with the rest of that viewer's namespace rather than
   * leak a stale results page into the next session.
   */
  jobDiscovery: (
    viewerId: ViewerId,
    filters: Readonly<Record<string, unknown>>,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'discovery',
    filters,
  ] as const,
  /**
   * `jobsService.getOrganizationJobs(employerOxyUserId)` — one organization or
   * project account's Jobs profile tab. Keyed by the EMPLOYER's id, not the
   * viewer's own — a profile's jobs are the same list for every visitor
   * (published only) or the fuller operator list (every status), and the
   * response itself already varies by caller authority, so this key only has
   * to keep one visitor's cached page from being served to another employer's
   * tab, not re-derive the authority split itself.
   */
  organizationJobs: (viewerId: ViewerId, employerOxyUserId: string) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'organization',
    employerOxyUserId,
  ] as const,
  /**
   * `jobApplicationsService.listForEmployer(jobId)` — the applicant inbox for
   * one job, optionally narrowed by status. One key per (job, status) pair
   * rather than one for the whole job: the inbox's own status tabs page
   * independently, and a status-scoped key lets switching tabs read a cached
   * page instead of refetching one the viewer already loaded this session.
   */
  /** Every status-filtered view of one job's applications — the prefix a status-change invalidates, since it moves a row between buckets. */
  jobApplicationsRoot: (viewerId: ViewerId, jobId: string) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'applications',
    jobId,
  ] as const,
  jobApplications: (
    viewerId: ViewerId,
    jobId: string,
    status?: string,
  ) => [
    ...viewerQueryKeys.jobApplicationsRoot(viewerId, jobId),
    status ?? 'all',
  ] as const,
  /** `jobApplicationsService.listNotes(jobId, applicationId)` — one application's internal notes thread. */
  jobApplicationNotes: (
    viewerId: ViewerId,
    jobId: string,
    applicationId: string,
  ) => [
    ...viewerQueryKeys.all(viewerId),
    'jobs',
    'application-notes',
    jobId,
    applicationId,
  ] as const,
  connectedAi: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'connected-ai',
  ] as const,
  interestsCategories: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'interests-categories',
  ] as const,
  /**
   * Every topic this viewer follows, read in one paginated sweep of the
   * user-owned follow graph rather than one status request per rendered chip.
   *
   * Holds the target ids and the SEED for the SDK's own store, never a second
   * copy of follow status: `useFollowTarget` takes an `initialStatus` for
   * exactly this case, and its store stays the sole authority once seeded.
   */
  followedTopics: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'follow-graph',
    'topics',
  ] as const,
  /**
   * The registered target id for ONE canonical URI.
   *
   * Keyed on the URI rather than on the slug or account id it was built from:
   * the URI is the identity the graph resolves, so two callers that build the
   * same one share a cache entry and two that build different ones cannot
   * silently collide.
   */
  followGraphTarget: (viewerId: ViewerId, uri: string) => [
    ...viewerQueryKeys.all(viewerId),
    'follow-graph',
    'target',
    uri,
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
  /**
   * Keyed on the SUBJECT as well as the viewer, because one viewer reads several
   * accounts' insights: their own, and every channel they operate. Without the
   * subject, opening a channel's dashboard would serve — and then overwrite — the
   * cache entry holding the viewer's own numbers, so the two would take turns
   * showing each other's figures under the wrong name.
   *
   * `'self'` for the viewer's own, which no Oxy user id can collide with.
   */
  insights: (viewerId: ViewerId, subjectId: string | null | undefined, period: string | number) => [
    ...viewerQueryKeys.all(viewerId),
    'insights',
    subjectId ?? 'self',
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
  /** Syra podcast shows the viewer is subscribed to (the podcast card's save button). */
  syraPodcastSubscriptions: (viewerId: ViewerId) => [
    ...viewerQueryKeys.all(viewerId),
    'syra-podcast-subscriptions',
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
  /**
   * Whichever viewer's {@link viewerQueryKeys.operatedAccounts} list this is.
   * The `accounts` family also holds `channelAccountSettings`, which a profile
   * edit never changes, so the family alone is too wide — and a caller that
   * reached past `isFamily` into `queryKey[3]` itself would be the second place
   * that knows this key's shape.
   */
  isOperatedAccounts: (queryKey: readonly unknown[]): boolean =>
    viewerQueryKeys.isFamily(queryKey, 'accounts') && queryKey[3] === 'operated',
  /**
   * ONE channel's writers list, whichever viewer's copy it is.
   *
   * Scoped rather than family-wide because the event that invalidates it names a
   * channel: its operator turned the byline on or off. A reader who has visited
   * several channels holds an entry for each, and the others did not change —
   * refetching them would spend a request to arrive back at the same answer, and
   * on a channel that does not disclose, that answer is a 404.
   */
  isChannelWriters: (queryKey: readonly unknown[], channelId: string): boolean =>
    viewerQueryKeys.isFamily(queryKey, 'channel-writers') && queryKey[3] === channelId,
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
