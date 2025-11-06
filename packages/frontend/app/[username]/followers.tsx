import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import * as OxyServicesNS from '@oxyhq/services';
import { Link, useLocalSearchParams, router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import LegendList from '@/components/LegendList';
import { useUsersStore } from '@/stores/usersStore';
import { useTheme } from '@/hooks/useTheme';

export default function FollowersScreen() {
  const insets = useSafeAreaInsets();
  const { username } = useLocalSearchParams<{ username: string }>();
  const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
  const { oxyServices } = (OxyServicesNS as any).useOxy();
  const [loading, setLoading] = useState(true);
  const [followers, setFollowers] = useState<any[]>([]);
  const [profile, setProfile] = useState<any | null>(null);
  const { t } = useTranslation();
  const theme = useTheme();
  const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string }>;

  useEffect(() => {
    const loadFollowers = async () => {
      try {
        const userProfile = await useUsersStore.getState().ensureByUsername(
          cleanUsername,
          (u) => oxyServices.getProfileByUsername(u)
        );
        if (!userProfile) {
          throw new Error('User profile is null');
        }
        if (userProfile?._id || userProfile?.id) {
          setProfile(userProfile);
          const followersList: any = await oxyServices.getUserFollowers((userProfile as any)._id || (userProfile as any).id);
          console.log('Followers:', followersList);
          const list = Array.isArray(followersList?.followers)
            ? followersList.followers
            : Array.isArray(followersList)
              ? followersList
              : [];
          setFollowers(list);
          try { useUsersStore.getState().upsertMany(list as any); } catch {}
        }
      } catch (error) {
        console.error('Error loading followers:', error);
      } finally {
        setLoading(false);
      }
    };

    loadFollowers();
  }, [cleanUsername, oxyServices]);

  const renderUser = ({ item }: { item: any }) => (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      padding: 16,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.COLOR_BLACK_LIGHT_6
    }}>
      <Link href={`/@${item.username}`} asChild>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
          <Avatar source={(item as any)?.avatar?.url || (item as any)?.avatar} size={40} />
          <View style={{ marginLeft: 12, flex: 1 }}>
            <ThemedText style={{ fontWeight: '600' }}>
              {item.profile?.name?.full ?? item.username}
            </ThemedText>
            <ThemedText style={{ color: colors.COLOR_BLACK_LIGHT_4 }}>@{item.username}</ThemedText>
          </View>
        </View>
      </Link>
      <FollowButton userId={(item as any).id || (item as any)._id || (item as any).userID} />
    </View>
  );

  if (loading) {
    return (
      <ThemedView style={{ flex: 1, paddingTop: insets.top }}>
        <Header 
          options={{ 
            title: t("Followers"), 
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
        <ActivityIndicator style={{ marginTop: 20 }} />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={{ flex: 1, paddingTop: insets.top }}>
      <Header
        options={{
          title: `${profile?.profile?.name?.full ?? cleanUsername} ${t("Followers")}`,
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
      <LegendList
        data={followers}
        renderItem={renderUser}
        keyExtractor={(item: any) => String((item as any).id || (item as any)._id || (item as any).userID || (item as any).username)}
        ListEmptyComponent={
          <View style={{ padding: 16, alignItems: 'center' }}>
            <ThemedText>{t("No followers yet")}</ThemedText>
          </View>
        }
        removeClippedSubviews={false}
        maxToRenderPerBatch={10}
        windowSize={10}
        initialNumToRender={10}
        recycleItems={true}
        maintainVisibleContentPosition={true}
      />
    </ThemedView>
  );
}
