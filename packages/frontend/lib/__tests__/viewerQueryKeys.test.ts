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
      viewerQueryKeys.lanesRoot(viewerId),
      viewerQueryKeys.ownedLanes(viewerId),
      viewerQueryKeys.mutedLanes(viewerId),
      viewerQueryKeys.lanesForOwner(viewerId, 'owner-1'),
      viewerQueryKeys.operatedLanes(viewerId, 'channel-account-1'),
      viewerQueryKeys.operatedAccounts(viewerId),
      viewerQueryKeys.channelAccountSettings(viewerId, 'channel-account-1'),
      viewerQueryKeys.pokesRoot(viewerId),
      viewerQueryKeys.pokes(viewerId, 'received'),
      viewerQueryKeys.notificationsRoot(viewerId),
      viewerQueryKeys.subscriptions(viewerId),
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
      viewerQueryKeys.followedTopics(viewerId),
      viewerQueryKeys.followGraphTarget(viewerId, 'https://oxy.so/topics/climate'),
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
      viewerQueryKeys.insights(viewerId, null, 30),
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

  it('separates one viewer’s insights from each account they operate', () => {
    // One viewer reads several accounts' insights — their own, plus every channel
    // they operate — so the SUBJECT has to be part of the key as well as the
    // viewer. Without it, opening a channel's dashboard would read and then
    // overwrite the entry holding the viewer's own numbers, and the two would
    // take turns rendering each other's figures under the wrong name.
    const own = viewerQueryKeys.insights('viewer-a', undefined, 30);
    const channel = viewerQueryKeys.insights('viewer-a', 'channel-1', 30);
    const otherChannel = viewerQueryKeys.insights('viewer-a', 'channel-2', 30);

    expect(own).not.toEqual(channel);
    expect(channel).not.toEqual(otherChannel);
    // The period still separates windows of the SAME subject.
    expect(channel).not.toEqual(viewerQueryKeys.insights('viewer-a', 'channel-1', 7));
    // …and the viewer still separates two operators of the same channel.
    expect(channel).not.toEqual(viewerQueryKeys.insights('viewer-b', 'channel-1', 30));
    // An absent subject is the viewer's own, under a token no Oxy id can be.
    expect(own).toContain('self');
    expect(viewerQueryKeys.insights('viewer-a', null, 30)).toEqual(own);
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
    expect(viewerQueryKeys.lanesForOwner('viewer-a', undefined)).toContain('');
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
      publicQueryKeys.topicCatalogue('climate'),
      publicQueryKeys.trendingHistory(),
      publicQueryKeys.trendSummary('kremer trade'),
      publicQueryKeys.trendGraph(null, null),
    ];

    keys.forEach((key) => {
      expect(key.slice(0, 2)).toEqual(['mention', 'public']);
      expect(key).not.toContain('viewer-a');
    });
    expect(mentionQueryKeys.public).toBe(publicQueryKeys);
    expect(mentionQueryKeys.private).toBe(viewerQueryKeys);
  });

  it('keys the trend graph on BOTH of its filters', () => {
    // The server returns a different graph per scope. One key for every scope
    // would hand a reader the unfiltered graph's edges after they picked a
    // language — edges whose endpoints are no longer on screen.
    expect(publicQueryKeys.trendGraph('es', null)).not.toEqual(
      publicQueryKeys.trendGraph('en', null),
    );
    expect(publicQueryKeys.trendGraph('es', 'es')).not.toEqual(
      publicQueryKeys.trendGraph('es', null),
    );
    expect(publicQueryKeys.trendGraph(null, null)).toEqual([
      'mention',
      'public',
      'trend-graph',
      'all',
      'all',
    ]);
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

  it('matches the operated-accounts list without matching its channel-settings sibling', () => {
    // An identity write invalidates the accounts LIST (the composer's publish-as
    // picker reads it) and must leave the Mention-owned per-channel settings row
    // alone — both live in the `accounts` family, so the family alone is too wide.
    expect(
      viewerQueryKeys.isOperatedAccounts(viewerQueryKeys.operatedAccounts('viewer-a')),
    ).toBe(true);
    expect(
      viewerQueryKeys.isOperatedAccounts(
        viewerQueryKeys.channelAccountSettings('viewer-a', 'acct-1'),
      ),
    ).toBe(false);
    expect(
      viewerQueryKeys.isOperatedAccounts(viewerQueryKeys.notifications('viewer-a')),
    ).toBe(false);
  });

  it('matches ONE channel\'s writers list, not the whole family', () => {
    // A byline write names one channel. A reader holding several channels' writer
    // lists must not have the others refetched — on a channel that does not
    // disclose, that request spends itself re-deriving a 404.
    const changed = viewerQueryKeys.channelWriters('viewer-a', 'channel-1');
    expect(viewerQueryKeys.isChannelWriters(changed, 'channel-1')).toBe(true);
    expect(viewerQueryKeys.isChannelWriters(changed, 'channel-2')).toBe(false);
    expect(
      viewerQueryKeys.isChannelWriters(
        viewerQueryKeys.channelAccountSettings('viewer-a', 'channel-1'),
        'channel-1',
      ),
    ).toBe(false);
    // A channel id the caller does not have resolves to the empty slot the key
    // factory writes, so it must not be matched by a real id.
    expect(
      viewerQueryKeys.isChannelWriters(
        viewerQueryKeys.channelWriters('viewer-a', undefined),
        'channel-1',
      ),
    ).toBe(false);
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
