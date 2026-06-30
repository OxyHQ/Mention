import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ThemedText } from '@/components/ThemedText';
import { Avatar } from '@oxyhq/bloom/avatar';

import { StableFollowButton } from '@/components/StableFollowButton';
import { useLocalSearchParams, router, usePathname } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View, TouchableOpacity, Share, Platform, StyleSheet } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { VirtualList } from '@oxyhq/bloom/list';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { precacheProfileViews } from '@/lib/precacheProfiles';
import { useTheme } from '@oxyhq/bloom/theme';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useAuth } from '@oxyhq/services';
import { Ionicons } from '@expo/vector-icons';
import { Error as ErrorComponent } from '@/components/Error';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { useProfileScreenColor } from '@/hooks/useProfileScreenColor';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { logger } from '@/lib/logger';
import { useRecommendations } from '@/hooks/useRecommendations';
import { type ProfileData as RecommendedProfile } from '@/lib/recommendations';
import { isAuthError } from '@/utils/authErrors';
import { displayNameOrHandle } from '@/utils/displayName';
import { getNormalizedUserHandle } from '@oxyhq/core';

type TabType = 'followers' | 'following' | 'who-may-know' | 'in-common';

/**
 * How long a fetched who-may-know page stays fresh before React Query refetches
 * it on remount/focus. The backend already caches per-viewer for ~90s; a
 * slightly shorter client window keeps suggestions fresh without re-hitting the
 * endpoint every time the user toggles between connection tabs.
 */
const RECOMMENDATIONS_STALE_TIME_MS = 60_000;

interface ConnectionUser {
  id?: string;
  _id?: string;
  userID?: string;
  username?: string;
  handle?: string;
  // Populated from the SDK `User` (avatar is `string | null`).
  avatar?: string | null;
  profilePicture?: string;
  bio?: string;
  isFederated?: boolean;
  type?: string;
  instance?: string;
  federation?: {
    domain?: string;
  };
  name?: {
    first?: string;
    last?: string;
    full?: string;
    displayName?: string;
  };
  profile?: {
    bio?: string;
  };
}

/**
 * Adapt a shared-recommendations {@link RecommendedProfile} to the local
 * {@link ConnectionUser} row shape used by followers/following/mutuals. Explicit
 * (rather than a cast) because `RecommendedProfile`'s `[key: string]: unknown`
 * index signature makes it non-assignable to `ConnectionUser`'s typed fields.
 */
function toConnectionUser(profile: RecommendedProfile): ConnectionUser {
  return {
    id: profile.id,
    username: profile.username,
    avatar: profile.avatar,
    bio: profile.bio,
    isFederated: profile.isFederated,
    instance: profile.instance,
    federation: profile.federation ? { domain: profile.federation.domain } : undefined,
    name: profile.name,
  };
}

export default function ConnectionsScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const { data: profileData, loading: profileLoading } = useProfileData(cleanUsername);
  const { colorName: profileColorName } = useProfileScreenColor({
    username: cleanUsername,
    designColor: profileData?.design?.color,
  });

  return (
    <BloomColorScope colorPreset={profileColorName} asChild>
      <ConnectionsContent
        routeUsername={username}
        cleanUsername={cleanUsername}
        profileData={profileData}
        profileLoading={profileLoading}
      />
    </BloomColorScope>
  );
}

interface ConnectionsContentProps {
  routeUsername?: string;
  cleanUsername: string;
  profileData: ProfileData | null;
  profileLoading: boolean;
}

function ConnectionsContent({
  routeUsername,
  cleanUsername,
  profileData,
  profileLoading,
}: ConnectionsContentProps) {
  const insets = useSafeAreaInsets();
  const safeBack = useSafeBack();
  const pathname = usePathname();
  const { oxyServices, user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followers, setFollowers] = useState<ConnectionUser[]>([]);
  const [following, setFollowing] = useState<ConnectionUser[]>([]);
  const { t } = useTranslation();
  const theme = useTheme();

  const profileHandle = getNormalizedUserHandle({
    username: profileData?.username || cleanUsername,
    instance: profileData?.instance,
    isFederated: profileData?.isFederated,
  }) || cleanUsername;

  // Determine active tab from pathname
  const getActiveTab = useCallback((): TabType => {
    if (pathname?.endsWith('/following')) return 'following';
    if (pathname?.endsWith('/who-may-know')) return 'who-may-know';
    if (pathname?.endsWith('/in-common')) return 'in-common';
    return 'followers';
  }, [pathname]);

  const [activeTab, setActiveTab] = useState<TabType>(() => {
    if (pathname?.endsWith('/following')) return 'following';
    if (pathname?.endsWith('/who-may-know')) return 'who-may-know';
    if (pathname?.endsWith('/in-common')) return 'in-common';
    return 'followers';
  });

  useEffect(() => {
    const newTab = getActiveTab();
    if (newTab !== activeTab) {
      setActiveTab(newTab);
    }
  }, [pathname, activeTab, getActiveTab]);

  // Load followers
  const loadFollowers = useCallback(async () => {
    if (!profileData?.id) return;

    try {
      setError(null);
      const followersList = await oxyServices.getUserFollowers(profileData.id);
      const list = followersList.followers;
      setFollowers(list);
      precacheProfileViews(queryClient, list);
    } catch (err) {
      // Followers are public; on an auth error show the empty state rather than
      // a scary error for logged-out visitors.
      if (isAuthError(err)) {
        logger.warn('Auth error loading followers, showing empty state', { error: err });
        setFollowers([]);
      } else {
        const message = err instanceof globalThis.Error ? err.message : 'Failed to load followers';
        setError(message);
        logger.error('Error loading followers', { error: err });
      }
    }
  }, [profileData?.id, oxyServices]);

  // Load following
  const loadFollowing = useCallback(async () => {
    if (!profileData?.id) return;

    try {
      setError(null);
      const followingList = await oxyServices.getUserFollowing(profileData.id);
      const list = followingList.following;
      setFollowing(list);
      precacheProfileViews(queryClient, list);
    } catch (err) {
      // Following lists are public; on an auth error show the empty state rather
      // than a scary error for logged-out visitors.
      if (isAuthError(err)) {
        logger.warn('Auth error loading following, showing empty state', { error: err });
        setFollowing([]);
      } else {
        const message = err instanceof globalThis.Error ? err.message : 'Failed to load following';
        setError(message);
        logger.error('Error loading following', { error: err });
      }
    }
  }, [profileData?.id, oxyServices]);

  // Who-may-know recommendations are personalized for the SIGNED-IN VIEWER (not
  // the profile being viewed) by `GET /recommendations` — an optional-auth,
  // public endpoint (popular profiles logged-out, mutual-overlap personalized
  // when a bearer is attached; it soft-fails to an empty list and never 401s).
  //
  // React Query owns this load, keyed on the viewer identity, for reasons the
  // previous hand-rolled effect + useState could not provide and which caused
  // the intermittent empty list:
  //
  //  1. De-dup + per-key correctness. On web cold boot the session restores
  //     asynchronously (~5-25s via /sso), and `loadCurrentTab` was recreated
  //     every time EITHER `profileData?.id` or `user?.id` landed — re-firing the
  //     fetch effect and launching 2-3 concurrent `fetchRecommendations()` calls
  //     with no stale-guard or cancellation. The last response to resolve won
  //     regardless of which request it belonged to, so an out-of-order anonymous
  //     (or soft-failed empty) response could clobber the good authenticated one.
  //     With the viewer in the query key, anonymous and authenticated fetches are
  //     SEPARATE, deduped queries: a stale response can no longer overwrite the
  //     current key's data.
  //  2. Refetch when the session lands. The key changes `anon` -> `<viewerId>`,
  //     so the personalized list loads automatically once cold boot completes.
  //  3. `keepPreviousData` keeps the anonymous list visible during that
  //     transition, so the list never flashes empty.
  //
  // This is intentionally NOT gated on `canUsePrivateApi`: the endpoint is public
  // and must still serve popular profiles logged-out. The only gate is the active
  // tab, so we fetch when (and only when) who-may-know is shown. Routed through
  // the shared `useRecommendations` hook so this tab reads the SAME cache entry
  // as the explore Who-to-follow tab and the right-rail widget.
  const recommendationsQuery = useRecommendations({ enabled: activeTab === 'who-may-know' });
  const recommendations = useMemo<ConnectionUser[]>(
    () => recommendationsQuery.recommendations.map(toConnectionUser),
    [recommendationsQuery.recommendations],
  );

  // "In common" = mutual followers between the SIGNED-IN VIEWER and the profile
  // being viewed (people the viewer follows who also follow this profile). The
  // SDK derives the viewer from the auth token, so — exactly like
  // recommendations above — React Query owns this load keyed on the viewer
  // identity (`anon` -> `<viewerId>`), `keepPreviousData` avoids an empty flash
  // during the cold-boot session transition, and the endpoint soft-fails to an
  // empty list (own profile / signed out / no mutuals) rather than throwing.
  const inCommonQuery = useQuery<ConnectionUser[]>({
    queryKey: ['connections', 'mutuals', profileData?.id ?? '', user?.id ?? 'anon'],
    queryFn: async () => {
      const targetId = profileData?.id;
      if (!targetId) return [];
      try {
        const result = await oxyServices.getUserMutuals(targetId, { limit: 50 });
        const list = result.mutuals;
        precacheProfileViews(queryClient, list);
        return list;
      } catch (err) {
        // Mutuals require a viewer; on an auth error (no usable bearer yet on
        // cold boot) show the empty state rather than a scary error. Non-auth
        // errors propagate so React Query surfaces them and retries.
        if (isAuthError(err)) {
          logger.warn('Auth error loading mutuals, showing empty state', { error: err });
          return [];
        }
        throw err;
      }
    },
    enabled: activeTab === 'in-common' && Boolean(profileData?.id),
    placeholderData: keepPreviousData,
    staleTime: RECOMMENDATIONS_STALE_TIME_MS,
  });
  const mutuals = useMemo<ConnectionUser[]>(
    () => inCommonQuery.data ?? [],
    [inCommonQuery.data],
  );

  // Load data based on active tab. The viewer-relative tabs (who-may-know and
  // in-common) are owned by React Query above; only the public
  // followers/following lists flow through this imperative path.
  const loadCurrentTab = useCallback(async () => {
    setLoading(true);
    try {
      if (activeTab === 'followers') {
        await loadFollowers();
      } else if (activeTab === 'following') {
        await loadFollowing();
      }
    } finally {
      setLoading(false);
    }
  }, [activeTab, loadFollowers, loadFollowing]);

  // Depend on profileData?.id (primitive) instead of profileData (object reference)
  // to avoid re-fetching when the profile object is re-created with identical content
  // (e.g. after the actor cache is primed with the same data). Who-may-know and
  // in-common are excluded here — they are driven by their React Query above,
  // not this effect.
  const profileId = profileData?.id;
  useEffect(() => {
    if (profileId && activeTab !== 'who-may-know' && activeTab !== 'in-common') {
      loadCurrentTab();
    }
  }, [activeTab, profileId, loadCurrentTab]);

  const handleTabPress = useCallback((tabId: string) => {
    if (!routeUsername) return;
    const tab = tabId as TabType;
    const subroute = tab === 'who-may-know' ? 'who-may-know' : tab;
    router.push(`/@${profileHandle}/${subroute}`);
  }, [profileHandle, routeUsername]);

  const getInviteMessage = useCallback(() => {
    const userHandle = user?.username || '';
    const appUrl = 'https://mention.earth';
    const viewerName = user?.name.displayName ?? 'Someone';

    if (userHandle) {
      return t('settings.inviteContacts.shareMessageWithHandle', {
        name: viewerName,
        handle: userHandle,
        url: appUrl,
        defaultValue: `Join me on Mention! ${viewerName} (@${userHandle})\n${appUrl}`
      });
    } else {
      return t('settings.inviteContacts.shareMessage', {
        name: viewerName,
        url: appUrl,
        defaultValue: `Join me on Mention! ${viewerName}\n${appUrl}`
      });
    }
  }, [user, t]);

  const handleInviteFriends = useCallback(async () => {
    const inviteMessage = getInviteMessage();

    if (Platform.OS === 'web') {
      if (navigator.share) {
        try {
          await navigator.share({
            title: t('settings.inviteContacts.inviteTitle', { defaultValue: 'Join me on Mention' }),
            text: inviteMessage,
            url: 'https://mention.earth',
          });
        } catch (e) {
          // User cancelled or error
        }
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(inviteMessage);
      }
      return;
    }

    try {
      await Share.share({
        message: inviteMessage,
      });
    } catch (err: unknown) {
      const shareErr = err as { message?: string; code?: string };
      if (shareErr?.message !== 'User did not share' && shareErr?.code !== 'ERR_SHARE_CANCELLED') {
        logger.error('Error inviting friends', { error: err });
      }
    }
  }, [getInviteMessage, t]);

  const renderUser = useCallback(({ item }: { item: ConnectionUser }) => {
    const usernameValue = item?.username || item?.handle;
    if (!usernameValue) return null;
    const instance = item?.instance || item?.federation?.domain;
    const isFederated = item?.isFederated || item?.type === 'federated';
    const handle = getNormalizedUserHandle({
      username: String(usernameValue),
      instance,
      isFederated,
    });
    if (!handle) return null;

    const avatarSource = item?.avatar ?? item.profilePicture;
    const bio = item?.profile?.bio || item?.bio;
    const userId = String(item.id || item._id || item.userID || '');
    if (!userId) return null;
    // A real display name is the bold primary with the muted @handle below; with
    // no display name the @handle becomes the bold primary, shown ONCE.
    const hasName = !!item.name?.displayName?.trim();

    return (
      <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          className="flex-row items-center flex-1"
          onPress={() => router.push(`/@${handle}`)}
          activeOpacity={0.7}
        >
          <Avatar source={avatarSource || undefined} size={48} />
          <View className="ml-3 flex-1">
            <ThemedText className="font-semibold text-base text-foreground" numberOfLines={1}>
              {displayNameOrHandle(item.name?.displayName, `@${handle}`)}
            </ThemedText>
            {hasName ? (
              <ThemedText className="pt-0.5 text-sm text-muted-foreground" numberOfLines={1}>
                @{handle}
              </ThemedText>
            ) : null}
            {bio ? (
              <ThemedText className="pt-1 text-sm leading-[18px] text-muted-foreground" numberOfLines={2}>
                {bio}
              </ThemedText>
            ) : null}
          </View>
        </TouchableOpacity>
        <StableFollowButton userId={userId} size="small" />
      </View>
    );
  }, [router, theme.colors.border]);

  const renderInviteBanner = useCallback(() => (
    <TouchableOpacity
      className="flex-row items-center p-3 mx-4 mt-3 mb-2 rounded-[20px] border bg-card border-border"
      style={{ gap: 10 }}
      onPress={handleInviteFriends}
      activeOpacity={0.7}
    >
      <View className="w-10 h-10 rounded-full items-center justify-center bg-primary">
        <Ionicons name="people" size={20} color={theme.colors.card} />
      </View>
      <View className="flex-1">
        <ThemedText className="text-[15px] font-bold mb-0.5 text-foreground">
          {t('settings.inviteContacts.inviteBannerTitle', { defaultValue: 'Invite friends from your contacts' })}
        </ThemedText>
        <ThemedText className="text-[13px] font-medium text-muted-foreground">
          {t('settings.inviteContacts.inviteBannerSubtitle', { defaultValue: 'Share Mention and grow your community.' })}
        </ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  ), [handleInviteFriends, theme.colors.card, theme.colors.textSecondary, t]);

  const currentData = useMemo(() => {
    switch (activeTab) {
      case 'followers':
        return followers;
      case 'following':
        return following;
      case 'who-may-know':
        return recommendations;
      case 'in-common':
        return mutuals;
      default:
        return [];
    }
  }, [activeTab, followers, following, recommendations, mutuals]);

  const profileDisplayName = profileData?.design.displayName;

  const getEmptyMessage = () => {
    switch (activeTab) {
      case 'followers':
        return t('connections.emptyFollowers', { defaultValue: 'No followers yet' });
      case 'following':
        return t('connections.emptyFollowing', { defaultValue: 'Not following anyone yet' });
      case 'who-may-know':
        return t('connections.emptyRecommendations', { defaultValue: 'No recommendations available' });
      case 'in-common':
        return t('connections.emptyInCommon', { defaultValue: 'No mutual followers' });
      default:
        return '';
    }
  };

  const getEmptySubtitle = () => {
    switch (activeTab) {
      case 'followers':
        if (!profileDisplayName) return '';
        return t('connections.emptyFollowersSubtitle', {
          name: profileDisplayName,
          defaultValue: `When people follow ${profileDisplayName}, they'll appear here.`,
        });
      case 'following':
        if (!profileDisplayName) return '';
        return t('connections.emptyFollowingSubtitle', {
          name: profileDisplayName,
          defaultValue: `When ${profileDisplayName} follows people, they'll appear here.`,
        });
      case 'who-may-know':
        return t('connections.emptyRecommendationsSubtitle', {
          defaultValue: 'Check back later for suggestions.',
        });
      case 'in-common':
        return t('connections.emptyInCommonSubtitle', {
          defaultValue: "People you follow who also follow this account will appear here.",
        });
      default:
        return '';
    }
  };

  const getTitle = () => {
    switch (activeTab) {
      case 'followers':
        return profileDisplayName
          ? `${profileDisplayName} ${t('Followers', { defaultValue: 'Followers' })}`
          : t('Followers', { defaultValue: 'Followers' });
      case 'following':
        return profileDisplayName
          ? `${profileDisplayName} ${t('Following', { defaultValue: 'Following' })}`
          : t('Following', { defaultValue: 'Following' });
      case 'who-may-know':
        return t('Who May Know', { defaultValue: 'Who May Know' });
      case 'in-common':
        return t('connections.tabs.inCommon', { defaultValue: 'In common' });
      default:
        return '';
    }
  };

  const tabs = useMemo(() => [
    { id: 'followers', label: t('Followers', { defaultValue: 'Followers' }) },
    { id: 'following', label: t('Following', { defaultValue: 'Following' }) },
    { id: 'in-common', label: t('connections.tabs.inCommon', { defaultValue: 'In common' }) },
    { id: 'who-may-know', label: t('Who May Know', { defaultValue: 'Who May Know' }) },
  ], [t]);

  // Loading/error/refresh are sourced per-tab: the viewer-relative tabs
  // (who-may-know, in-common) read their React Query state, while
  // followers/following keep using the imperative state.
  const isRecommendationsTab = activeTab === 'who-may-know';
  const isInCommonTab = activeTab === 'in-common';
  const isQueryTab = isRecommendationsTab || isInCommonTab;
  const { refetch: refetchRecommendations } = recommendationsQuery;
  const { refetch: refetchInCommon } = inCommonQuery;
  // The two viewer-relative tabs read from different sources — `inCommonQuery` is
  // a raw React Query result, `recommendationsQuery` is the shared hook's shape —
  // so the active async state is selected per-tab rather than via a single union.
  const activeIsError = isInCommonTab ? inCommonQuery.isError : recommendationsQuery.isError;
  const activeErrorObj = isInCommonTab ? inCommonQuery.error : recommendationsQuery.error;
  const activeIsPending = isInCommonTab ? inCommonQuery.isPending : recommendationsQuery.isLoading;
  const activeIsFetching = isInCommonTab ? inCommonQuery.isFetching : recommendationsQuery.isFetching;
  const queryErrorMessage = activeIsError
    ? activeErrorObj instanceof globalThis.Error
      ? activeErrorObj.message
      : isInCommonTab
        ? t('connections.failedInCommon', { defaultValue: 'Failed to load mutual followers' })
        : t('connections.failedRecommendations', { defaultValue: 'Failed to load recommendations' })
    : null;
  const activeLoading = isQueryTab ? activeIsPending : loading;
  const activeError = isQueryTab ? queryErrorMessage : error;
  const activeRefreshing = isQueryTab ? activeIsFetching : loading;
  const refreshCurrent = useCallback(() => {
    if (isInCommonTab) {
      void refetchInCommon();
    } else if (isRecommendationsTab) {
      refetchRecommendations();
    } else {
      void loadCurrentTab();
    }
  }, [isInCommonTab, isRecommendationsTab, refetchInCommon, refetchRecommendations, loadCurrentTab]);

  const renderContent = () => {
    if (activeError && currentData.length === 0 && !activeLoading) {
      return (
        <ErrorComponent
          title={t('Error', { defaultValue: 'Error' })}
          message={activeError}
          onRetry={refreshCurrent}
          hideBackButton={true}
          style={{ flex: 1, paddingVertical: 40 }}
        />
      );
    }

    if (activeLoading && currentData.length === 0) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-4">
          <Loading className="text-primary" size="large" />
          <ThemedText className="text-base text-muted-foreground">
            {t('Loading...', { defaultValue: 'Loading...' })}
          </ThemedText>
        </View>
      );
    }

    if (profileLoading && activeTab !== 'who-may-know') {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-4">
          <Loading className="text-primary" size="large" />
          <ThemedText className="text-base text-muted-foreground">
            {t('Loading...', { defaultValue: 'Loading...' })}
          </ThemedText>
        </View>
      );
    }

    return (
      <VirtualList
        data={currentData}
        renderItem={renderUser}
        keyExtractor={(item: ConnectionUser) => String(item.id || item._id || item.userID || item.username)}
        ListHeaderComponent={activeTab === 'who-may-know' ? renderInviteBanner : undefined}
        ListEmptyComponent={
          <View className="items-center py-[60px] px-8 gap-2">
            <Ionicons name="people-outline" size={48} color={theme.colors.textSecondary} />
            <ThemedText className="text-[17px] font-bold mt-2 text-center text-foreground">
              {getEmptyMessage()}
            </ThemedText>
            <ThemedText className="text-sm leading-5 text-center text-muted-foreground">
              {getEmptySubtitle()}
            </ThemedText>
          </View>
        }
        removeClippedSubviews={false}
        maxToRenderPerBatch={10}
        windowSize={10}
        initialNumToRender={10}
        recycleItems={true}
        maintainVisibleContentPosition={true}
        contentContainerStyle={{ paddingBottom: 20 }}
        refreshing={activeRefreshing}
        onRefresh={refreshCurrent}
      />
    );
  };

  return (
    <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
      <Header
        options={{
          title: getTitle(),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => safeBack()}
            >
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <AnimatedTabBar
        tabs={tabs}
        activeTabId={activeTab}
        onTabPress={handleTabPress}
        scrollEnabled={true}
        instanceId={`connections-${cleanUsername}`}
      />

      {renderContent()}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 0.5,
    paddingVertical: 12,
    paddingHorizontal: 16,
    ...Platform.select({ web: { cursor: 'pointer' as const } }),
  },
});
