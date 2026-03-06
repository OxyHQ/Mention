import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { federationService } from '@/services/federationService';
import PostItem from '@/components/Feed/PostItem';
import type { FederatedActorProfile } from '@mention/shared-types';

export default function FederatedProfileScreen() {
  const { uri } = useLocalSearchParams<{ uri: string }>();
  const theme = useTheme();
  const decodedUri = decodeURIComponent(uri || '');

  const [actor, setActor] = useState<FederatedActorProfile | null>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [followLoading, setFollowLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();

  useEffect(() => {
    if (!decodedUri) return;
    loadProfile();
  }, [decodedUri]);

  const loadProfile = async () => {
    setLoading(true);
    try {
      const [actorData, postsData] = await Promise.all([
        federationService.getActorProfile(decodedUri),
        federationService.getActorPosts(decodedUri),
      ]);
      setActor(actorData);
      setPosts(postsData.posts);
      setHasMore(postsData.hasMore);
      setNextCursor(postsData.nextCursor);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!hasMore || !nextCursor) return;
    const data = await federationService.getActorPosts(decodedUri, nextCursor);
    setPosts((prev) => [...prev, ...data.posts]);
    setHasMore(data.hasMore);
    setNextCursor(data.nextCursor);
  };

  const handleFollow = async () => {
    if (!actor) return;
    setFollowLoading(true);
    try {
      if (actor.isFollowing || actor.isFollowPending) {
        await federationService.unfollow(actor.actorUri);
        setActor((prev) => prev ? { ...prev, isFollowing: false, isFollowPending: false } : null);
      } else {
        const result = await federationService.follow(actor.actorUri);
        setActor((prev) => prev ? {
          ...prev,
          isFollowing: !result.pending,
          isFollowPending: result.pending,
        } : null);
      }
    } finally {
      setFollowLoading(false);
    }
  };

  const openOnInstance = useCallback(() => {
    if (decodedUri) Linking.openURL(decodedUri);
  }, [decodedUri]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.background }}>
        <Stack.Screen options={{ title: 'Fediverse Profile' }} />
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!actor) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.background }}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <Ionicons name="globe-outline" size={48} color={theme.colors.textSecondary} />
        <Text style={{ color: theme.colors.textSecondary, marginTop: 12, fontSize: 16 }}>
          Actor not found
        </Text>
      </View>
    );
  }

  const followButtonLabel = actor.isFollowPending
    ? 'Pending'
    : actor.isFollowing
      ? 'Following'
      : 'Follow';

  const followButtonStyle = actor.isFollowing || actor.isFollowPending
    ? { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.colors.border }
    : { backgroundColor: theme.colors.primary };

  const followTextColor = actor.isFollowing || actor.isFollowPending
    ? theme.colors.text
    : '#fff';

  const renderHeader = () => (
    <View style={{ paddingBottom: 16 }}>
      {/* Banner */}
      {actor.bannerUrl ? (
        <Image source={{ uri: actor.bannerUrl }} style={{ width: '100%', height: 150 }} />
      ) : (
        <View style={{ width: '100%', height: 100, backgroundColor: theme.colors.border }} />
      )}

      {/* Avatar + Follow */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 16, marginTop: -30 }}>
        <Image
          source={{ uri: actor.avatarUrl }}
          style={{ width: 72, height: 72, borderRadius: 36, borderWidth: 3, borderColor: theme.colors.background }}
        />
        <View style={{ flexDirection: 'row', gap: 8, paddingBottom: 4 }}>
          <TouchableOpacity
            onPress={openOnInstance}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border }}
          >
            <Ionicons name="open-outline" size={16} color={theme.colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleFollow}
            disabled={followLoading}
            style={[{ paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 }, followButtonStyle]}
          >
            {followLoading ? (
              <ActivityIndicator size="small" color={followTextColor} />
            ) : (
              <Text style={{ color: followTextColor, fontWeight: '600', fontSize: 14 }}>
                {followButtonLabel}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Name + handle */}
      <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: theme.colors.text }}>
          {actor.displayName}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <Ionicons name="globe-outline" size={14} color={theme.colors.textSecondary} />
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
            {actor.fullHandle}
          </Text>
        </View>
      </View>

      {/* Bio */}
      {actor.bio ? (
        <Text style={{ paddingHorizontal: 16, marginTop: 8, fontSize: 15, color: theme.colors.text, lineHeight: 20 }}>
          {actor.bio.replace(/<[^>]*>/g, '')}
        </Text>
      ) : null}

      {/* Stats */}
      <View style={{ flexDirection: 'row', gap: 16, paddingHorizontal: 16, marginTop: 12 }}>
        <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
          <Text style={{ fontWeight: '700', color: theme.colors.text }}>{actor.followingCount ?? 0}</Text> Following
        </Text>
        <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
          <Text style={{ fontWeight: '700', color: theme.colors.text }}>{actor.followersCount ?? 0}</Text> Followers
        </Text>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Stack.Screen options={{ title: actor.displayName || 'Fediverse Profile' }} />
      <FlatList
        data={posts}
        keyExtractor={(item) => item._id || item.id}
        renderItem={({ item }) => <PostItem post={item} />}
        ListHeaderComponent={renderHeader}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          <View style={{ padding: 32, alignItems: 'center' }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 15 }}>
              No posts available
            </Text>
          </View>
        }
      />
    </View>
  );
}
