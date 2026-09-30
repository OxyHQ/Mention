import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiGroupFill } from '@oxy.so/bloom/icons/RiGroupFill';
import { ProfileCard, ProfileCardSkeletonList, type ProfileCardData } from '@/components/ProfileCard';
import { useLocalSearchParams, router, usePathname } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View, TouchableOpacity, Share, Platform } from 'react-native';
import { VirtualList } from '@oxy.so/bloom/list';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { BloomColorScope, useTheme } from '@oxy.so/bloom/theme';
import { EmptyState } from '@/components/common/EmptyState';
import type { EmptyStateStickerName } from '@/lib/stickers';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { cacheActors } from '@/lib/actorCache';
import { useAuth } from '@oxy.so/services/ui/client';
import { Error as ErrorComponent } from '@/components/Error';
import { ProfileUnavailable } from '@/components/Profile/ProfileUnavailable';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { useProfileScreenColor } from '@/hooks/useProfileScreenColor';
import { logger } from '@oxy.so/core/logger';
import { useRecommendations } from '@/hooks/useRecommendations';
import { type ProfileData as RecommendedProfile } from '@/lib/recommendations';
import { isAuthError } from '@/utils/authErrors';
import { getErrorMessage } from '@/utils/apiError';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

type TabType = 'followers' | 'following' | 'who-may-know' | 'in-common';

/** The catalogue sticker each tab shows when it has nobody to list. */
const EMPTY_STICKER_BY_TAB: Record<TabType, EmptyStateStickerName> = {
  followers: 'connectionsFollowers',
  following: 'connectionsFollowing',
  'who-may-know': 'connectionsRecommendations',
  'in-common': 'connectionsInCommon',
};

/**
 * How long a fetched who-may-know page stays fresh before React Query refetches
 * it on remount/focus. The backend already caches per-viewer for ~90s; a
 * slightly shorter client window keeps suggestions fresh without re-hitting the
 * endpoint every time the user toggles between connection tabs.
 */
const RECOMMENDATIONS_STALE_TIME_MS = 60_000;

/** Placeholder rows painted while a connections tab loads. */
const SKELETON_ROW_COUNT = 8;

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

/**
 * Map a connection row onto the shared {@link ProfileCard} shape. Returns null
 * for a row with no id or no resolvable handle — an unidentified user must never
 * render as a profile link (the ghost-handle rule).
 */
function toProfileCardData(item: ConnectionUser): ProfileCardData | null {
  const id = String(item.id || item._id || item.userID || '');
  const username = item.username || item.handle;
  if (!id || !username) return null;
  return {
    id,
    username,
    name: item.name,
    avatar: item.avatar ?? item.profilePicture,
    description: item.profile?.bio || item.bio,
    isFederated: item.isFederated || item.type === 'federated',
    instance: item.instance,
    federation: item.federation,
  };
}

export default function ConnectionsScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const {
    data: profileData,
    loading: profileLoading,
    error: profileError,
    notFound: profileNotFound,
    refresh: refreshProfile,
  } = useProfileData(cleanUsername);
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
        profileError={profileError}
        profileNotFound={profileNotFound}
        refreshProfile={refreshProfile}
      />
    </BloomColorScope>
  );
}

interface ConnectionsContentProps {
  routeUsername?: string;
  cleanUsername: string;
  profileData: ProfileData | null;
  profileLoading: boolean;
  /** The profile lookup ended with nothing to show. */
  profileError: boolean;
  /** ...because the account does not exist — not a failure worth retrying. */
  profileNotFound: boolean;
  refreshProfile: () => Promise<void>;
}

function ConnectionsContent({
  routeUsername,
  cleanUsername,
  profileData,
  profileLoading,
  profileError,
  profileNotFound,
  refreshProfile,
}: ConnectionsContentProps) {
  const safeBack = useSafeBack();
  const pathname = usePathname();
  const { oxyServices, user } = useAuth();
  const { t } = useTranslation();
  const theme = useTheme();

  const profileHandle = getNormalizedUserHandle({
    username: profileData?.username || cleanUsername,
    instance: profileData?.instance,
    isFederated: profileData?.isFederated,
  }) || cleanUsername;

  // The route IS the active tab — `handleTabPress` navigates, so there is
  // nothing else that could select one. Derived rather than held in state, which
  // is what made the old copy need an effect to chase the pathname.
  const activeTab: TabType = pathname?.endsWith('/following')
    ? 'following'
    : pathname?.endsWith('/who-may-know')
      ? 'who-may-know'
      : pathname?.endsWith('/in-common')
        ? 'in-common'
        : 'followers';

  const profileId = profileData?.id;

  // The profile's public followers / following. React Query owns this load like
  // the two viewer-relative tabs below, and for the reason that mattered here:
  // the old imperative loader held its own `loading` flag, started `true`, and
  // only a fetch could clear it — but it only fetched once the PROFILE had an
  // id. A handle with no account never gets one, so the list sat on its
  // skeletons forever beside a "Profile not found" title (OxyHQ/Mention#1124).
  // A query that is not enabled is simply not loading.
  const listKind: 'followers' | 'following' | null =
    activeTab === 'followers' || activeTab === 'following' ? activeTab : null;
  const connectionsListQuery = useQuery<ConnectionUser[]>({
    queryKey: viewerQueryKeys.connectionsList(user?.id, listKind ?? 'followers', profileId),
    queryFn: async () => {
      if (!profileId) return [];
      try {
        const list = listKind === 'following'
          ? (await oxyServices.follows.following(profileId)).following
          : (await oxyServices.follows.followers(profileId)).followers;
        cacheActors(list);
        return list;
      } catch (err) {
        // The lists are public; an auth error (no usable bearer yet on cold
        // boot, or a signed-out visitor) shows the empty state, not an error.
        if (isAuthError(err)) {
          logger.warn('Auth error loading connections, showing empty state', { error: err });
          return [];
        }
        throw err;
      }
    },
    enabled: listKind !== null && Boolean(profileId),
    staleTime: RECOMMENDATIONS_STALE_TIME_MS,
  });
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
    queryKey: viewerQueryKeys.connectionsMutuals(user?.id, profileId),
    queryFn: async () => {
      const targetId = profileId;
      if (!targetId) return [];
      try {
        const result = await oxyServices.follows.mutuals(targetId, { limit: 50 });
        const list = result.mutuals;
        cacheActors(list);
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
    enabled: activeTab === 'in-common' && Boolean(profileId),
    placeholderData: keepPreviousData,
    staleTime: RECOMMENDATIONS_STALE_TIME_MS,
  });
  const mutuals = useMemo<ConnectionUser[]>(
    () => inCommonQuery.data ?? [],
    [inCommonQuery.data],
  );

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
        } catch {
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
        logger.error('Error inviting friends', err);
      }
    }
  }, [getInviteMessage, t]);

  const renderUser = useCallback(({ item }: { item: ConnectionUser }) => {
    const profile = toProfileCardData(item);
    if (!profile) return null;
    return <ProfileCard profile={profile} showFollowButton />;
  }, []);

  const renderInviteBanner = useCallback(() => (
    <TouchableOpacity
      className="flex-row items-center p-3 mx-4 mt-3 mb-2 rounded-[20px] border bg-card border-border"
      style={{ gap: 10 }}
      onPress={handleInviteFriends}
      activeOpacity={0.7}
    >
      <View className="w-10 h-10 rounded-full items-center justify-center bg-primary">
        <RiGroupFill size="md" fill={theme.colors.card} />
      </View>
      <View className="flex-1">
        <Text className="text-[15px] font-bold mb-0.5 text-foreground">
          {t('settings.inviteContacts.inviteBannerTitle', { defaultValue: 'Invite friends from your contacts' })}
        </Text>
        <Text className="text-[13px] font-medium text-muted-foreground">
          {t('settings.inviteContacts.inviteBannerSubtitle', { defaultValue: 'Share Mention and grow your community.' })}
        </Text>
      </View>
      <RiArrowRightSLine size="md" fill={theme.colors.textSecondary} />
    </TouchableOpacity>
  ), [handleInviteFriends, theme.colors.card, theme.colors.textSecondary, t]);

  const currentData = useMemo(() => {
    switch (activeTab) {
      case 'followers':
      case 'following':
        return connectionsListQuery.data ?? [];
      case 'who-may-know':
        return recommendations;
      case 'in-common':
        return mutuals;
      default:
        return [];
    }
  }, [activeTab, connectionsListQuery.data, recommendations, mutuals]);

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

  // Every tab is one query, and the active tab's decides loading, error and
  // refresh. The shared recommendations hook exposes the same field names.
  const isRecommendationsTab = activeTab === 'who-may-know';
  const isInCommonTab = activeTab === 'in-common';
  const activeQuery = isRecommendationsTab
    ? recommendationsQuery
    : isInCommonTab
      ? inCommonQuery
      : connectionsListQuery;
  const activeFailure = isRecommendationsTab
    ? t('connections.failedRecommendations', { defaultValue: 'Failed to load recommendations' })
    : isInCommonTab
      ? t('connections.failedInCommon', { defaultValue: 'Failed to load mutual followers' })
      : activeTab === 'following'
        ? t('connections.failedFollowing', { defaultValue: 'Failed to load following' })
        : t('connections.failedFollowers', { defaultValue: 'Failed to load followers' });
  const activeError = activeQuery.isError ? getErrorMessage(activeQuery.error, activeFailure) : null;
  const activeLoading = activeQuery.isLoading;
  const activeRefreshing = activeQuery.isFetching;
  const { refetch: refetchActive } = activeQuery;
  const refreshCurrent = useCallback(() => {
    void refetchActive();
  }, [refetchActive]);

  // Who-may-know is about the VIEWER, so it is the one tab that does not need
  // the profile in the URL to exist.
  const needsProfile = !isRecommendationsTab;

  const renderContent = () => {
    if (needsProfile && !profileData && !profileLoading && profileError) {
      return (
        <ProfileUnavailable
          notFound={profileNotFound}
          onRetry={refreshProfile}
          notFoundMessage={t('connections.profileNotFound', {
            defaultValue: "This account doesn't exist, so it has no followers to show.",
          })}
        />
      );
    }

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

    // Every tab of this screen is a list of the SAME user row, so both waits (the
    // tab's own fetch, and the profile lookup that keys it) paint the row
    // skeletons rather than a centered spinner the list then replaces.
    const isWaitingForRows =
      (activeLoading && currentData.length === 0) ||
      (needsProfile && profileLoading);
    if (isWaitingForRows) {
      return <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton />;
    }

    return (
      <VirtualList
        data={currentData}
        renderItem={renderUser}
        keyExtractor={(item: ConnectionUser) => String(item.id || item._id || item.userID || item.username)}
        ListHeaderComponent={activeTab === 'who-may-know' ? renderInviteBanner : undefined}
        ListEmptyComponent={
          <EmptyState
            title={getEmptyMessage()}
            subtitle={getEmptySubtitle() || undefined}
            sticker={EMPTY_STICKER_BY_TAB[activeTab]}
            containerStyle={{ paddingTop: 60 }}
          />
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
    <View className="flex-1">
      <PageHeader
        title={getTitle()}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />

      <Tabs value={activeTab} onValueChange={handleTabPress} variant="underline">{(tabs).map((tab: { id: string; label: string; count?: number }) => <TabsTrigger key={tab.id} value={tab.id} label={tab.label} count={tab.count} />)}</Tabs>

      {renderContent()}
    </View>
  );
}
