import { Header } from '@/components/Header';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import { Avatar, FollowButton, Models, useOxy } from '@oxyhq/services';
import { Link, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, View } from 'react-native';

export default function FollowersScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
  const { user, oxyServices } = useOxy();
  const [loading, setLoading] = useState(true);
  const [followers, setFollowers] = useState<Models.User[]>([]);
  const [profile, setProfile] = useState<Models.User | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const loadFollowers = async () => {
      try {
        const userProfile = await oxyServices.getProfileByUsername(cleanUsername);
        if (!userProfile) {
          throw new Error('User profile is null');
        }
        if (userProfile?._id) {
          setProfile(userProfile);
          const followersList = await oxyServices.getUserFollowers(userProfile._id);
          console.log('Followers:', followersList);
          setFollowers(followersList || []);
        }
      } catch (error) {
        console.error('Error loading followers:', error);
      } finally {
        setLoading(false);
      }
    };

    loadFollowers();
  }, [cleanUsername, oxyServices]);

  const renderUser = ({ item }: { item: Models.User }) => (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      padding: 16,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.COLOR_BLACK_LIGHT_6 
    }}>
      <Link href={`/@${item.username}`} asChild>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
          <Avatar uri={item.avatar?.url} size={40} />
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
        <Header options={{ title: t("Followers"), showBackButton: true }} />
        <ActivityIndicator style={{ marginTop: 20 }} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Header options={{ title: `${profile?.name?.first ? `${profile.name.first} ${profile.name.last || ''}`.trim() : username} ${t("Followers")}`, showBackButton: true }} />
      <FlatList
        data={followers}
        renderItem={renderUser}
        keyExtractor={(item) => item._id || item.userID}
        ListEmptyComponent={
          <View style={{ padding: 16, alignItems: 'center' }}>
            <ThemedText>{t("No followers yet")}</ThemedText>
          </View>
        }
      />
    </View>
  );
}