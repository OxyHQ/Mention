import { QueryClient } from '@tanstack/react-query';
import {
  clearViewerQueryCache,
  mentionQueryKeys,
  publicQueryKeys,
  viewerQueryKeys,
  viewerStorageKey,
} from '@/lib/viewerQueryKeys';

describe('viewer-scoped private cache', () => {
  function everyPrivateKey(viewerId: string) {
    return [
      viewerQueryKeys.all(viewerId),
      viewerQueryKeys.postsRoot(viewerId),
      viewerQueryKeys.post(viewerId, 'post-1'),
      viewerQueryKeys.pinnedPost(viewerId, 'profile-1'),
      viewerQueryKeys.scheduledPosts(viewerId),
      viewerQueryKeys.feedsRoot(viewerId),
      viewerQueryKeys.feed(viewerId, 'custom', { language: 'es' }),
      viewerQueryKeys.search(viewerId, 'posts', 'query', true),
      viewerQueryKeys.searchHistory(viewerId),
      viewerQueryKeys.livePresence(viewerId),
      viewerQueryKeys.savedPostsRoot(viewerId),
      viewerQueryKeys.savedPosts(viewerId, 'query', 'work'),
      viewerQueryKeys.bookmarkFolders(viewerId),
      viewerQueryKeys.listsRoot(viewerId),
      viewerQueryKeys.ownedLists(viewerId),
      viewerQueryKeys.followedLists(viewerId),
      viewerQueryKeys.list(viewerId, 'list-1'),
      viewerQueryKeys.listMembers(viewerId, 'list-1', ['user-1']),
      viewerQueryKeys.pokesRoot(viewerId),
      viewerQueryKeys.pokes(viewerId, 'received'),
      viewerQueryKeys.notificationsRoot(viewerId),
      viewerQueryKeys.notifications(viewerId),
      viewerQueryKeys.notificationActors(viewerId, ['actor-1']),
      viewerQueryKeys.unreadNotifications(viewerId),
      viewerQueryKeys.similarProfiles(viewerId, 'source-1'),
      viewerQueryKeys.mutualFollowers(viewerId, 'profile-1'),
      viewerQueryKeys.knownLikers(viewerId, 'post-1'),
      viewerQueryKeys.connectionsMutuals(viewerId, 'profile-1'),
      viewerQueryKeys.customFeedsRoot(viewerId),
      viewerQueryKeys.customFeedTitles(viewerId),
      viewerQueryKeys.customFeed(viewerId, 'feed-1'),
      viewerQueryKeys.customFeedMarketplace(viewerId, { sort: 'trending' }),
      viewerQueryKeys.feedInterstitial(viewerId, 'suggested-feeds'),
      viewerQueryKeys.starterPacksMine(viewerId),
      viewerQueryKeys.connectedAi(viewerId),
      viewerQueryKeys.interestsCategories(viewerId),
      viewerQueryKeys.myAppearance(viewerId),
      viewerQueryKeys.appearanceForUser(viewerId, 'user-1'),
      viewerQueryKeys.muteWords(viewerId),
      viewerQueryKeys.feedPreferences(viewerId),
      viewerQueryKeys.feedTuning(viewerId),
      viewerQueryKeys.feedSettings(viewerId),
      viewerQueryKeys.labelers(viewerId, 'search'),
      viewerQueryKeys.postInsights(viewerId, 'post-1'),
      viewerQueryKeys.profileFeeds(viewerId, 'profile-1', false),
      viewerQueryKeys.profileStarterPacks(viewerId, 'profile-1', false),
      viewerQueryKeys.profileLists(viewerId, 'profile-1', false),
      viewerQueryKeys.weeklyRecap(viewerId),
      viewerQueryKeys.insights(viewerId, 30),
      viewerQueryKeys.recommendationFilters(viewerId),
      viewerQueryKeys.recommendations(viewerId, 'agent'),
      viewerQueryKeys.infiniteRecommendations(viewerId, 'agent'),
      viewerQueryKeys.viewerFollowing(viewerId),
      viewerQueryKeys.postActivity(viewerId, 'profile-1'),
      viewerQueryKeys.mentionNode(viewerId),
      viewerQueryKeys.federatedProfile(viewerId, 'alice@example.com'),
      viewerQueryKeys.liveUsers(viewerId),
      viewerQueryKeys.profileMediaSearch(viewerId, 'song', 'query'),
    ];
  }

  it('keeps A and B on distinct query and storage keys', () => {
    expect(viewerQueryKeys.search('viewer-a', 'saved', 'oxy', true)).not.toEqual(
      viewerQueryKeys.search('viewer-b', 'saved', 'oxy', true),
    );
    expect(viewerQueryKeys.livePresence('viewer-a')).not.toEqual(
      viewerQueryKeys.livePresence('viewer-b'),
    );
    expect(viewerQueryKeys.savedPosts('viewer-a', '', null)).not.toEqual(
      viewerQueryKeys.savedPosts('viewer-b', '', null),
    );
    expect(viewerQueryKeys.bookmarkFolders('viewer-a')).not.toEqual(
      viewerQueryKeys.bookmarkFolders('viewer-b'),
    );
    expect(viewerStorageKey('history', 'viewer-a')).toBe('history:viewer-a');
    expect(viewerStorageKey('history', 'viewer-b')).toBe('history:viewer-b');
  });

  it('roots every private key in the normalized viewer namespace', () => {
    const aKeys = everyPrivateKey('viewer-a');
    const bKeys = everyPrivateKey('viewer-b');

    expect(aKeys).toHaveLength(bKeys.length);
    aKeys.forEach((key, index) => {
      expect(key.slice(0, 2)).toEqual(['viewer', 'viewer-a']);
      expect(key).not.toEqual(bKeys[index]);
    });

    expect(viewerQueryKeys.all(undefined)).toEqual(['viewer', 'anon']);
    expect(viewerQueryKeys.all('   ')).toEqual(['viewer', 'anon']);
    expect(viewerQueryKeys.similarProfiles('viewer-a', undefined)).toContain('');
    expect(viewerQueryKeys.mutualFollowers('viewer-a', undefined)).toContain('');
    expect(viewerQueryKeys.knownLikers('viewer-a', undefined)).toContain('');
    expect(viewerQueryKeys.connectionsMutuals('viewer-a', undefined)).toContain('');
    expect(viewerQueryKeys.profileFeeds('viewer-a', undefined, true)).toContain('');
    expect(viewerQueryKeys.profileStarterPacks('viewer-a', undefined, true)).toContain('');
    expect(viewerQueryKeys.profileLists('viewer-a', undefined, true)).toContain('');
    expect(viewerQueryKeys.postActivity('viewer-a', undefined)).toContain('');
    expect(viewerQueryKeys.feedInterstitial(
      'viewer-a',
      'suggested-starter-packs',
      'subject-1',
    )).toContain('subject-1');
  });

  it('keeps truly anonymous catalogs in a separate public namespace', () => {
    const keys = [
      publicQueryKeys.all(),
      publicQueryKeys.customFeedReviews('feed-1'),
      publicQueryKeys.externalActorResolve('alice@example.com'),
      publicQueryKeys.feedModules(),
      publicQueryKeys.marketplaceCategories(),
      publicQueryKeys.trendingHistory(),
      publicQueryKeys.trendSummary('kremer trade'),
    ];

    keys.forEach((key) => {
      expect(key.slice(0, 2)).toEqual(['mention', 'public']);
      expect(key).not.toContain('viewer-a');
    });
    expect(mentionQueryKeys.public).toBe(publicQueryKeys);
    expect(mentionQueryKeys.private).toBe(viewerQueryKeys);
  });

  it('matches cross-viewer invalidation families without matching public keys', () => {
    const appearanceKey = viewerQueryKeys.appearanceForUser('viewer-a', 'user-1');
    expect(viewerQueryKeys.isFamily(appearanceKey, 'appearance')).toBe(true);
    expect(viewerQueryKeys.isFamily(publicQueryKeys.feedModules(), 'feed-modules')).toBe(false);
    expect(viewerQueryKeys.isAppearanceForUser(appearanceKey, 'user-1')).toBe(true);
    expect(viewerQueryKeys.isAppearanceForUser(appearanceKey, 'user-2')).toBe(false);
    expect(viewerQueryKeys.isAppearanceForUser(
      viewerQueryKeys.notifications('viewer-a'),
      'user-1',
    )).toBe(false);
  });

  it('removes only A when the active account switches A to B', async () => {
    const queryClient = new QueryClient();
    const aSearch = viewerQueryKeys.search('viewer-a', 'saved', 'oxy', true);
    const aPresence = viewerQueryKeys.livePresence('viewer-a');
    const aSaved = viewerQueryKeys.savedPosts('viewer-a', 'query', 'work');
    const aFolders = viewerQueryKeys.bookmarkFolders('viewer-a');
    const bSearch = viewerQueryKeys.search('viewer-b', 'saved', 'oxy', true);

    queryClient.setQueryData(aSearch, { owner: 'viewer-a' });
    queryClient.setQueryData(aPresence, 'speaking');
    queryClient.setQueryData(aSaved, [{ owner: 'viewer-a' }]);
    queryClient.setQueryData(aFolders, ['work']);
    queryClient.setQueryData(bSearch, { owner: 'viewer-b' });

    await clearViewerQueryCache(queryClient, 'viewer-a');

    expect(queryClient.getQueryData(aSearch)).toBeUndefined();
    expect(queryClient.getQueryData(aPresence)).toBeUndefined();
    expect(queryClient.getQueryData(aSaved)).toBeUndefined();
    expect(queryClient.getQueryData(aFolders)).toBeUndefined();
    expect(queryClient.getQueryData(bSearch)).toEqual({ owner: 'viewer-b' });

    queryClient.clear();
  });
});
