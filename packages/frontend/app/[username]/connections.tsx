import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import * as OxyServicesNS from '@oxyhq/services';
import { Link, useLocalSearchParams, router, usePathname } from 'expo-router';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View, TouchableOpacity, Share, Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import LegendList from '@/components/LegendList';
import { useUsersStore } from '@/stores/usersStore';
import { useTheme } from '@/hooks/useTheme';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useOxy } from '@oxyhq/services';
import { Ionicons } from '@expo/vector-icons';

type TabType = 'followers' | 'following' | 'who-may-know';

export default function ConnectionsScreen() {
  const insets = useSafeAreaInsets();
  const { username } = useLocalSearchParams<{ username: string }>();
  const pathname = usePathname();
  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const { oxyServices, user } = useOxy();
  const [loading, setLoading] = useState(true);
  const [followers, setFollowers] = useState<any[]>([]);
  const [following, setFollowing] = useState<any[]>([]);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [profile, setProfile] = useState<any | null>(null);
  const { t } = useTranslation();
  const theme = useTheme();
  const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string; size?: 'small' | 'medium' | 'large' }>;

  // Determine active tab from pathname
  const getActiveTab = useCallback((): TabType => {
    if (pathname?.endsWith('/following')) return 'following';
    if (pathname?.endsWith('/who-may-know')) return 'who-may-know';
    return 'followers'; // Default
  }, [pathname]);

  const [activeTab, setActiveTab] = useState<TabType>(() => {
    if (pathname?.endsWith('/following')) return 'following';
    if (pathname?.endsWith('/who-may-know')) return 'who-may-know';
    return 'followers';
  });

  // Update active tab when pathname changes
  useEffect(() => {
    const newTab = getActiveTab();
    if (newTab !== activeTab) {
      setActiveTab(newTab);
    }
  }, [pathname, activeTab, getActiveTab]);

  // Load profile data
  useEffect(() => {
    const loadProfile = async () => {
      try {
        const userProfile = await useUsersStore.getState().ensureByUsername(
          cleanUsername,
          (u) => oxyServices.getProfileByUsername(u)
        );
        if (userProfile) {
          setProfile(userProfile);
        }
      } catch (error) {
        console.error('Error loading profile:', error);
      }
    };

    if (cleanUsername) {
      loadProfile();
    }
  }, [cleanUsername, oxyServices]);

  // Load followers
  const loadFollowers = useCallback(async () => {
    if (!profile?._id && !profile?.id) return;
    
    try {
      const followersList: any = await oxyServices.getUserFollowers((profile as any)._id || (profile as any).id);
      const list = Array.isArray(followersList?.followers)
        ? followersList.followers
        : Array.isArray(followersList)
          ? followersList
          : [];
      setFollowers(list);
      try { useUsersStore.getState().upsertMany(list as any); } catch {}
    } catch (error) {
      console.error('Error loading followers:', error);
    }
  }, [profile, oxyServices]);

  // Load following
  const loadFollowing = useCallback(async () => {
    if (!profile?._id && !profile?.id) return;
    
    try {
      const followingList: any = await oxyServices.getUserFollowing((profile as any)._id || (profile as any).id);
      const list = Array.isArray(followingList?.following)
        ? followingList.following
        : Array.isArray(followingList)
          ? followingList
          : [];
      setFollowing(list);
      try { useUsersStore.getState().upsertMany(list as any); } catch {}
    } catch (error) {
      console.error('Error loading following:', error);
    }
  }, [profile, oxyServices]);

  // Load recommendations (who may know)
  const loadRecommendations = useCallback(async () => {
    try {
      const response = await oxyServices.getProfileRecommendations();
      const recommendationsList = Array.isArray(response) ? response : [];
      setRecommendations(recommendationsList);
      try {
        if (recommendationsList.length) {
          useUsersStore.getState().upsertMany(recommendationsList as any);
        }
      } catch {}
    } catch (error) {
      console.error('Error loading recommendations:', error);
    }
  }, [oxyServices]);

  // Load data based on active tab
  useEffect(() => {
    const loadData = async () => {
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
    };

    if (profile || activeTab === 'who-may-know') {
      loadData();
    }
  }, [activeTab, profile, loadFollowers, loadFollowing, loadRecommendations]);

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
  }, [cleanUsername, router]);

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
    } catch (error: any) {
      if (error?.message !== 'User did not share' && error?.code !== 'ERR_SHARE_CANCELLED') {
        console.error('Error inviting friends:', error);
      }
    }
  }, [getInviteMessage, t]);

  const renderUser = ({ item }: { item: any }) => {
    const usernameValue = item?.username || item?.handle || item?.userID || item?.id;
    if (!usernameValue) {
      return null;
    }

    const displayName =
      item?.profile?.name?.full ||
      (item?.name?.first ? `${item.name.first} ${item.name.last || ''}`.trim() : '') ||
      item?.displayName ||
      usernameValue;

    const avatarSource =
      typeof item?.avatar === 'string'
        ? oxyServices.getFileDownloadUrl?.(item.avatar, 'thumb') ?? item.avatar
        : (item as any)?.avatar?.url || (item as any)?.avatar || (item as any)?.profilePicture;

    const bio = item?.profile?.bio || item?.bio;

    return (
      <View style={[styles.row, { borderBottomColor: theme.colors.border }]}> 
        <TouchableOpacity
          style={styles.rowLeft}
          onPress={() => router.push(`/@${usernameValue}` as any)}
          activeOpacity={0.75}
        >
        <Avatar source={avatarSource} size={40} />
          <View style={styles.rowTextWrap}>
            <ThemedText style={[styles.rowTitle, { color: theme.colors.text }]}>
              {displayName}
            </ThemedText>
            <ThemedText style={[styles.rowSubtitle, { color: theme.colors.textSecondary }]}>
              @{usernameValue}
            </ThemedText>
            {bio ? (
              <ThemedText
                style={[styles.rowBio, { color: theme.colors.textSecondary }]}
                numberOfLines={1}
              >
                {bio}
              </ThemedText>
            ) : null}
          </View>
        </TouchableOpacity>
        <FollowButton
          userId={(item as any).id || (item as any)._id || (item as any).userID}
          size="small"
        />
      </View>
    );
  };

  const renderInviteBanner = useCallback(() => (
    <View style={styles.inviteWrapper}>
      <TouchableOpacity
        onPress={handleInviteFriends}
        activeOpacity={0.75}
        style={[styles.inviteRow, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
      >
        <View style={[styles.inviteIcon, { backgroundColor: theme.colors.primary }]}>
          <Ionicons name="people" size={18} color={theme.colors.card} />
        </View>
        <View style={styles.inviteTextWrap}>
          <ThemedText style={[styles.inviteTitle, { color: theme.colors.text }]}>
            {t('settings.inviteContacts.inviteBannerTitle', { defaultValue: 'Invite friends from your contacts' })}
          </ThemedText>
          <ThemedText style={[styles.inviteSubtitle, { color: theme.colors.textSecondary }]}>
            {t('settings.inviteContacts.inviteBannerSubtitle', { defaultValue: 'Share Mention and grow your community.' })}
          </ThemedText>
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
      </TouchableOpacity>
    </View>
  ), [handleInviteFriends, theme.colors.border, theme.colors.card, theme.colors.primary, theme.colors.text, theme.colors.textSecondary, t]);

  const getCurrentData = () => {
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
  };

  const getEmptyMessage = () => {
    switch (activeTab) {
      case 'followers':
        return t("No followers yet", { defaultValue: 'No followers yet' });
      case 'following':
        return t("No following yet", { defaultValue: 'No following yet' });
      case 'who-may-know':
        return t("No recommendations available", { defaultValue: 'No recommendations available' });
      default:
        return '';
    }
  };

  const profileDisplayName = useMemo(() => (
    profile?.profile?.name?.full ||
    (profile?.name?.first ? `${profile.name.first} ${profile.name.last || ''}`.trim() : '') ||
    profile?.displayName ||
    cleanUsername
  ), [profile, cleanUsername]);

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

  const tabs = [
    { id: 'followers', label: t('Followers', { defaultValue: 'Followers' }) },
    { id: 'following', label: t('Following', { defaultValue: 'Following' }) },
    { id: 'who-may-know', label: t('Who May Know', { defaultValue: 'Who May Know' }) },
  ];

  return (
    <ThemedView style={{ flex: 1, paddingTop: insets.top }}>
      <Header
        options={{
          title: getTitle(),
          leftComponents: [
            <HeaderIconButton
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
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

      {loading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <ThemedText style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
            {t('Loading...', { defaultValue: 'Loading...' })}
          </ThemedText>
        </View>
      ) : (
        <LegendList
          data={getCurrentData()}
          renderItem={renderUser}
          keyExtractor={(item: any) => String((item as any).id || (item as any)._id || (item as any).userID || (item as any).username)}
          ListHeaderComponent={activeTab === 'who-may-know' ? renderInviteBanner : undefined}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="people-outline" size={22} color={theme.colors.textSecondary} style={{ marginBottom: 4 }} />
              <ThemedText style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                {getEmptyMessage()}
              </ThemedText>
            </View>
          }
          removeClippedSubviews={false}
          maxToRenderPerBatch={10}
          windowSize={10}
          initialNumToRender={10}
          recycleItems={true}
          maintainVisibleContentPosition={true}
          contentContainerStyle={styles.listContent}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingHorizontal: 0,
    paddingBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 0.5,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
  },
  rowTextWrap: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowSubtitle: {
    fontSize: 13,
  },
  rowBio: {
    fontSize: 12,
    lineHeight: 16,
  },
  inviteWrapper: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
  },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 10,
  },
  inviteIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteTextWrap: {
    flex: 1,
    gap: 2,
  },
  inviteTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  inviteSubtitle: {
    fontSize: 12,
    lineHeight: 16,
  },
  emptyState: {
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
  },
  loadingState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  loadingText: {
    fontSize: 14,
  },
});

