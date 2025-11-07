import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import * as OxyServicesNS from '@oxyhq/services';
import { Link, useLocalSearchParams, router, usePathname } from 'expo-router';
import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View, TouchableOpacity, Share, Platform } from 'react-native';
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
  const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string }>;

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

  const renderUser = ({ item }: { item: any }) => (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      padding: 16,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border || colors.COLOR_BLACK_LIGHT_6
    }}>
      <Link href={`/@${item.username}`} asChild>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
          <Avatar source={(item as any)?.avatar?.url || (item as any)?.avatar || (item as any)?.profilePicture} size={40} />
          <View style={{ marginLeft: 12, flex: 1 }}>
            <ThemedText style={{ fontWeight: '600' }}>
              {item.profile?.name?.full || 
               (item.name?.first ? `${item.name.first} ${item.name.last || ''}`.trim() : '') ||
               item.displayName ||
               item.username}
            </ThemedText>
            <ThemedText style={{ color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_4 }}>@{item.username}</ThemedText>
          </View>
        </View>
      </Link>
      <FollowButton userId={(item as any).id || (item as any)._id || (item as any).userID} />
    </View>
  );

  const renderInviteBanner = () => (
    <TouchableOpacity
      onPress={handleInviteFriends}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        margin: 16,
        backgroundColor: theme.colors.backgroundSecondary || `${theme.colors.primary}15`,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Ionicons name="person-add-outline" size={20} color={theme.colors.primary} />
      <ThemedText style={{ marginLeft: 8, color: theme.colors.primary, fontWeight: '600' }}>
        {t('Invite friends', { defaultValue: 'Invite friends' })}
      </ThemedText>
    </TouchableOpacity>
  );

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

  const getTitle = () => {
    const profileName = profile?.profile?.name?.full || 
                       (profile?.name?.first ? `${profile.name.first} ${profile.name.last || ''}`.trim() : '') ||
                       profile?.displayName ||
                       cleanUsername;
    
    switch (activeTab) {
      case 'followers':
        return `${profileName} ${t("Followers", { defaultValue: 'Followers' })}`;
      case 'following':
        return `${profileName} ${t("Following", { defaultValue: 'Following' })}`;
      case 'who-may-know':
        return t("Who May Know", { defaultValue: 'Who May Know' });
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
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <LegendList
          data={getCurrentData()}
          renderItem={renderUser}
          keyExtractor={(item: any) => String((item as any).id || (item as any)._id || (item as any).userID || (item as any).username)}
          ListHeaderComponent={activeTab === 'who-may-know' ? renderInviteBanner : undefined}
          ListEmptyComponent={
            <View style={{ padding: 16, alignItems: 'center' }}>
              <ThemedText>{getEmptyMessage()}</ThemedText>
            </View>
          }
          removeClippedSubviews={false}
          maxToRenderPerBatch={10}
          windowSize={10}
          initialNumToRender={10}
          recycleItems={true}
          maintainVisibleContentPosition={true}
        />
      )}
    </ThemedView>
  );
}

