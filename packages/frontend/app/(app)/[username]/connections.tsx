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
import { useUsersStore } from '@/stores/usersStore';
import { useTheme } from '@oxyhq/bloom/theme';
import { APP_COLOR_PRESETS, getScopedColorCSSVariables } from '@/lib/app-color-presets';
import { vars } from 'react-native-css';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useAuth } from '@oxyhq/services';
import { Ionicons } from '@expo/vector-icons';
import { Error as ErrorComponent } from '@/components/Error';
import { useProfileData } from '@/hooks/useProfileData';
import { logger } from '@/lib/logger';

type TabType = 'followers' | 'following' | 'who-may-know';

export default function ConnectionsScreen() {
  const insets = useSafeAreaInsets();
  const safeBack = useSafeBack();
  const { username } = useLocalSearchParams<{ username: string }>();
  const pathname = usePathname();
  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const { oxyServices, user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followers, setFollowers] = useState<any[]>([]);
  const [following, setFollowing] = useState<any[]>([]);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const { t } = useTranslation();
  const theme = useTheme();
  const { data: profileData } = useProfileData(cleanUsername);

  // Scoped color override for visited user's color preset
  const isOwnProfile = user?.id === profileData?.id;
  const profileColorVars = useMemo(() => {
    const color = profileData?.design?.color;
    if (isOwnProfile || !color) return undefined;
    const preset = APP_COLOR_PRESETS[color as keyof typeof APP_COLOR_PRESETS];
    if (!preset) return undefined;
    return vars(getScopedColorCSSVariables(preset, theme.isDark ? 'dark' : 'light'));
  }, [isOwnProfile, profileData?.design?.color, theme.isDark]);

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
      try { useUsersStore.getState().upsertMany(list as any); } catch {}
    } catch (err) {
      const message = err instanceof globalThis.Error ? err.message : 'Failed to load followers';
      setError(message);
      logger.error('Error loading followers', { error: err });
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
      try { useUsersStore.getState().upsertMany(list as any); } catch {}
    } catch (err) {
      const message = err instanceof globalThis.Error ? err.message : 'Failed to load following';
      setError(message);
      logger.error('Error loading following', { error: err });
    }
  }, [profileData?.id, oxyServices]);

  // Load recommendations (who may know)
  const loadRecommendations = useCallback(async () => {
    try {
      setError(null);
      const response = await oxyServices.getProfileRecommendations();
      const recommendationsList = Array.isArray(response) ? response : [];
      setRecommendations(recommendationsList);
      try {
        if (recommendationsList.length) {
          useUsersStore.getState().upsertMany(recommendationsList as any);
        }
      } catch {}
    } catch (err) {
      const message = err instanceof globalThis.Error ? err.message : 'Failed to load recommendations';
      setError(message);
      logger.error('Error loading recommendations', { error: err });
    }
  }, [oxyServices]);

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
  // (e.g. after upsertMany updates the users store with the same data).
  const profileId = profileData?.id;
  useEffect(() => {
    if (profileId || activeTab === 'who-may-know') {
      loadCurrentTab();
    }
  }, [activeTab, profileId, loadCurrentTab]);

  const handleTabPress = useCallback((tabId: string) => {
    if (!username) return;
    const tab = tabId as TabType;

    let path: string;
    if (tab === 'following') {
      path = `/@${cleanUsername}/following`;
    } else if (tab === 'who-may-know') {
      path = `/@${cleanUsername}/who-may-know`;
    } else {
      path = `/@${cleanUsername}/followers`;
    }

    router.push(path as any);
  }, [cleanUsername, username]);

  const getInviteMessage = useCallback(() => {
    const userName = user
      ? typeof user.name === 'string'
        ? user.name
        : user.name?.full || user.name?.first || user.username
      : 'Someone';
    const userHandle = user?.username || '';
    const appUrl = 'https://mention.earth';

    if (userHandle) {
      return t('settings.inviteContacts.shareMessageWithHandle', {
        name: userName,
        handle: userHandle,
        url: appUrl,
        defaultValue: `Join me on Mention! ${userName} (@${userHandle})\n${appUrl}`
      });
    } else {
      return t('settings.inviteContacts.shareMessage', {
        name: userName,
        url: appUrl,
        defaultValue: `Join me on Mention! ${userName}\n${appUrl}`
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

  const renderUser = useCallback(({ item }: { item: any }) => {
    const usernameValue = item?.username || item?.handle || item?.userID || item?.id;
    if (!usernameValue) return null;

    const displayName =
      item?.profile?.name?.full ||
      (item?.name?.first ? `${item.name.first} ${item.name.last || ''}`.trim() : '') ||
      item?.displayName ||
      usernameValue;

    const avatarSource = item?.avatar ?? (item as any)?.profilePicture;
    const bio = item?.profile?.bio || item?.bio;
    const userId = String((item as any).id || (item as any)._id || (item as any).userID);

    return (
      <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          className="flex-row items-center flex-1"
          onPress={() => router.push(`/@${usernameValue}` as any)}
          activeOpacity={0.7}
        >
          <Avatar source={avatarSource || undefined} size={48} />
          <View className="ml-3 flex-1">
            <ThemedText className="font-semibold text-base text-foreground" numberOfLines={1}>
              {displayName}
            </ThemedText>
            <ThemedText className="pt-0.5 text-sm text-muted-foreground" numberOfLines={1}>
              @{usernameValue}
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
  }, [theme.colors.border]);

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

  const profileDisplayName = useMemo(() => (
    profileData?.design?.displayName ||
    profileData?.username ||
    cleanUsername
  ), [profileData, cleanUsername]);

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
        return t('connections.emptyFollowersSubtitle', {
          name: profileDisplayName,
          defaultValue: `When people follow ${profileDisplayName}, they'll appear here.`,
        });
      case 'following':
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
        return `${profileDisplayName} ${t('Followers', { defaultValue: 'Followers' })}`;
      case 'following':
        return `${profileDisplayName} ${t('Following', { defaultValue: 'Following' })}`;
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

    return (
      <LegendList
        data={currentData}
        renderItem={renderUser}
        keyExtractor={(item: any) => String((item as any).id || (item as any)._id || (item as any).userID || (item as any).username)}
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
    <ThemedView className="flex-1" style={[{ paddingTop: insets.top }, profileColorVars]}>
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
