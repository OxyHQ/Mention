import { Header } from '@/components/Header';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import * as OxyServicesNS from '@oxyhq/services';
import { Link, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import LegendList from '@/components/LegendList';

export default function FollowingScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
  const { oxyServices } = (OxyServicesNS as any).useOxy();
  const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState<any[]>([]);
  const [profile, setProfile] = useState<any | null>(null);
  const { t } = useTranslation();
  const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string }>; 

  useEffect(() => {
    const loadFollowing = async () => {
      try {
        const userProfile = await oxyServices.getProfileByUsername(cleanUsername);
        if (!userProfile) {
          throw new Error('User profile is null');
        }
        if (userProfile?._id || userProfile?.id) {
          setProfile(userProfile);
          const followingList: any = await oxyServices.getUserFollowing((userProfile as any)._id || (userProfile as any).id);
          console.log('Following:', followingList);
          const list = Array.isArray(followingList?.following)
            ? followingList.following
            : Array.isArray(followingList)
              ? followingList
              : [];
          setFollowing(list);
        }
      } catch (error) {
        console.error('Error loading following:', error);
      } finally {
        setLoading(false);
      }
    };

    loadFollowing();
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
              {item.name?.first ? `${item.name.first} ${item.name.last || ''}`.trim() : item.username}
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
      <ThemedView style={{ flex: 1 }}>
        <Header options={{ title: t("Following"), showBackButton: true }} />
        <ActivityIndicator style={{ marginTop: 20 }} />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={{ flex: 1 }}>
      <Header options={{ title: `${profile?.name?.first ? `${profile.name.first} ${profile.name.last || ''}`.trim() : cleanUsername} ${t("Following")}`, showBackButton: true }} />
      <LegendList
        data={following}
        renderItem={renderUser}
  keyExtractor={(item: any) => (item as any).id || (item as any)._id || (item as any).userID}
        ListEmptyComponent={
          <View style={{ padding: 16, alignItems: 'center' }}>
            <ThemedText>{t("No following yet")}</ThemedText>
          </View>
        }
  recycleItems={true}
  maintainVisibleContentPosition={true}
      />
    </ThemedView>
  );
}
