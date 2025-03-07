import React, { useEffect, useState } from 'react';
import { View, FlatList, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useProfile } from '@/modules/oxyhqservices/hooks/useProfile';
import { OxyProfile } from '@/modules/oxyhqservices/types';
import { colors } from '@/styles/colors';
import { Header } from '@/components/Header';
import Avatar from '@/components/Avatar';
import { FollowButton } from '@/modules/oxyhqservices';
import { ThemedText } from '@/components/ThemedText';
import { Link } from 'expo-router';

export default function FollowingScreen() {
    const { username } = useLocalSearchParams<{ username: string }>();
    const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
    const { getProfile, getIdByUsername, getFollowing } = useProfile();
    const [loading, setLoading] = useState(true);
    const [following, setFollowing] = useState<OxyProfile[]>([]);
    const [profile, setProfile] = useState<OxyProfile | null>(null);
    const { t } = useTranslation();

  useEffect(() => {
    const loadFollowing = async () => {
      try {
        const userId = await getIdByUsername(cleanUsername);
        if (!userId) {
          throw new Error('User ID is null');
        }
        const userProfile = await getProfile(userId);
        if (userProfile?._id) {
          setProfile(userProfile);
          const followingList = await getFollowing(userId);
          setFollowing(followingList || []);
        }
      } catch (error) {
        console.error('Error loading following:', error);
      } finally {
        setLoading(false);
      }
    };

    loadFollowing();
  }, [cleanUsername, getProfile, getFollowing]);

  const renderUser = ({ item }: { item: OxyProfile }) => (
    <View style={{ 
      flexDirection: 'row', 
      alignItems: 'center', 
      padding: 16,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.COLOR_BLACK_LIGHT_6 
    }}>
      <Link href={`/@${item.username}`} asChild>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
          <Avatar id={item.avatar} size={40} />
          <View style={{ marginLeft: 12, flex: 1 }}>
            <ThemedText style={{ fontWeight: '600' }}>
              {item.name?.first ? `${item.name.first} ${item.name.last || ''}`.trim() : item.username}
            </ThemedText>
            <ThemedText style={{ color: colors.COLOR_BLACK_LIGHT_4 }}>@{item.username}</ThemedText>
          </View>
        </View>
      </Link>
      <FollowButton userId={item._id || item.userID} />
    </View>
  );

  if (loading) {
    return (
      <View style={{ flex: 1 }}>
        <Header options={{ title: t("Following"), showBackButton: true }} />
        <ActivityIndicator style={{ marginTop: 20 }} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Header options={{ title: `${profile?.name?.first ? `${profile.name.first} ${profile.name.last || ''}`.trim() : username} ${t("Following")}`, showBackButton: true }} />
      <FlatList
        data={following}
        renderItem={renderUser}
        keyExtractor={(item) => item._id || item.userID}
        ListEmptyComponent={
          <View style={{ padding: 16, alignItems: 'center' }}>
            <ThemedText>{t("No following yet")}</ThemedText>
          </View>
        }
      />
    </View>
  );
}