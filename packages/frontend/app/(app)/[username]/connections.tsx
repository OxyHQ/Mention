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
import LegendList from '@/components/LegendList';
import { queryClient } from '@/lib/queryClient';
import { precacheProfileViews } from '@/lib/precacheProfiles';
import { useTheme } from '@oxyhq/bloom/theme';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useAuth } from '@oxyhq/services';
import { Ionicons } from '@expo/vector-icons';
import { Error as ErrorComponent } from '@/components/Error';
import { useProfileData } from '@/hooks/useProfileData';
import { useProfileScreenColor } from '@/hooks/useProfileScreenColor';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { logger } from '@/lib/logger';
import { isAuthError } from '@/utils/authErrors';
import { getNormalizedUserHandle } from '@oxyhq/core';

type TabType = 'followers' | 'following' | 'who-may-know';

interface ConnectionUser {
  id?: string;
  _id?: string;
  userID?: string;
  username?: string;
  handle?: string;
  displayName: string;
  avatar?: string;
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
  };
  profile?: {
    name?: {
      full?: string;
    };
    bio?: string;
  };
}

export default function ConnectionsScreen() {
  const insets = useSafeAreaInsets();
  const safeBack = useSafeBack();
  const { username } = useLocalSearchParams<{ username: string }>();
  const pathname = usePathname();
  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const { oxyServices, user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followers, setFollowers] = useState<ConnectionUser[]>([]);
  const [following, setFollowing] = useState<ConnectionUser[]>([]);
  const [recommendations, setRecommendations] = useState<ConnectionUser[]>([]);
  const { t } = useTranslation();
  const theme = useTheme();
  const { data: profileData, loading: profileLoading } = useProfileData(cleanUsername);

  const profileHandle = getNormalizedUserHandle({
    username: profileData?.username || cleanUsername,
    instance: profileData?.instance,
    isFederated: profileData?.isFederated,
  }) || cleanUsername;
  const { colorName: profileColorName } = useProfileScreenColor({
    username: cleanUsername,
    designColor: profileData?.design?.color,
  });

  // Determine active tab from pathname
  const getActiveTab = useCallback((): TabType => {
    if (pathname?.endsWith('/following')) return 'following';
    if (pathname?.endsWith('/who-may-know')) return 'who-may-know';
    return 'followers';
  }, [pathname]);

  const [activeTab, setActiveTab] = useState<TabType>(() => {
    if (pathname?.endsWith('/following')) return 'following';
    if (pathname?.endsWith('/who-may-know')) return 'who-may-know';
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
      const followersList: any = await oxyServices.getUserFollowers(profileData.id);
      const list = Array.isArray(followersList?.followers)
        ? followersList.followers
        : Array.isArray(followersList)
          ? followersList
          : [];
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
      const followingList: any = await oxyServices.getUserFollowing(profileData.id);
      const list = Array.isArray(followingList?.following)
        ? followingList.following
        : Array.isArray(followingList)
          ? followingList
          : [];
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

  // Load recommendations (who may know)
  const loadRecommendations = useCallback(async () => {
    try {
      setError(null);
      const response = await oxyServices.getProfileRecommendations();
      const recommendationsList = Array.isArray(response) ? response : [];
      setRecommendations(recommendationsList);
      precacheProfileViews(queryClient, recommendationsList);
    } catch (err) {
      // Recommendations are public; on an auth error show the empty state rather
      // than a scary error for logged-out visitors.
      if (isAuthError(err)) {
        logger.warn('Auth error loading recommendations, showing empty state', { error: err });
        setRecommendations([]);
      } else {
        const message = err instanceof globalThis.Error ? err.message : 'Failed to load recommendations';
        setError(message);
        logger.error('Error loading recommendations', { error: err });
      }
    }
    // `user?.id` is a dependency so recommendations refetch when the viewer's
    // auth session resolves on cold boot: who-may-know suggestions are
    // personalized for the signed-in viewer. `oxyServices` is a stable
    // singleton, so without this the list loads once while anonymous and never
    // updates after sign-in.
  }, [oxyServices, user?.id]);

  // Load data based on active tab
  const loadCurrentTab = useCallback(async () => {
    setLoading(true);
    try {
      if (activeTab === 'followers') {
        await loadFollowers();
      } else if (activeTab === 'following') {
        await loadFollowing();
      } else if (activeTab === 'who-may-know') {
        await loadRecommendations();
      }
    } finally {
      setLoading(false);
    }
  }, [activeTab, loadFollowers, loadFollowing, loadRecommendations]);

  // Depend on profileData?.id (primitive) instead of profileData (object reference)
  // to avoid re-fetching when the profile object is re-created with identical content
  // (e.g. after the actor cache is primed with the same data).
  const profileId = profileData?.id;
  useEffect(() => {
    if (profileId || activeTab === 'who-may-know') {
      loadCurrentTab();
    }
  }, [activeTab, profileId, loadCurrentTab]);

  const handleTabPress = useCallback((tabId: string) => {
    if (!username) return;
    const tab = tabId as TabType;
    const subroute = tab === 'who-may-know' ? 'who-may-know' : tab;
    router.push(`/@${profileHandle}/${subroute}`);
  }, [profileHandle, username]);

  const getInviteMessage = useCallback(() => {
    const userHandle = user?.username || '';
    const appUrl = 'https://mention.earth';

    if (userHandle) {
      return t('settings.inviteContacts.shareMessageWithHandle', {
        name: user?.displayName ?? 'Someone',
        handle: userHandle,
        url: appUrl,
        defaultValue: `Join me on Mention! ${user?.displayName ?? 'Someone'} (@${userHandle})\n${appUrl}`
      });
    } else {
      return t('settings.inviteContacts.shareMessage', {
        name: user?.displayName ?? 'Someone',
        url: appUrl,
        defaultValue: `Join me on Mention! ${user?.displayName ?? 'Someone'}\n${appUrl}`
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
              {item.displayName}
            </ThemedText>
            <ThemedText className="pt-0.5 text-sm text-muted-foreground" numberOfLines={1}>
              @{handle}
            </ThemedText>
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
      default:
        return [];
    }
  }, [activeTab, followers, following, recommendations]);

  const profileDisplayName = profileData?.design.displayName;

  const getEmptyMessage = () => {
    switch (activeTab) {
      case 'followers':
        return t('connections.emptyFollowers', { defaultValue: 'No followers yet' });
      case 'following':
        return t('connections.emptyFollowing', { defaultValue: 'Not following anyone yet' });
      case 'who-may-know':
        return t('connections.emptyRecommendations', { defaultValue: 'No recommendations available' });
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
      default:
        return '';
    }
  };

  const tabs = useMemo(() => [
    { id: 'followers', label: t('Followers', { defaultValue: 'Followers' }) },
    { id: 'following', label: t('Following', { defaultValue: 'Following' }) },
    { id: 'who-may-know', label: t('Who May Know', { defaultValue: 'Who May Know' }) },
  ], [t]);

  const renderContent = () => {
    if (error && currentData.length === 0 && !loading) {
      return (
        <ErrorComponent
          title={t('Error', { defaultValue: 'Error' })}
          message={error}
          onRetry={loadCurrentTab}
          hideBackButton={true}
          style={{ flex: 1, paddingVertical: 40 }}
        />
      );
    }

    if (loading && currentData.length === 0) {
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
      <LegendList
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
        refreshing={loading}
        onRefresh={loadCurrentTab}
      />
    );
  };

  return (
    <BloomColorScope colorPreset={profileColorName} asChild>
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
    </BloomColorScope>
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
