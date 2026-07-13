import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import { feedService } from '@/services/feedService';
import { ProfileCard, ProfileCardSkeletonList } from '@/components/ProfileCard';

import { useRouter } from 'expo-router';
import { EmptyState } from '@/components/common/EmptyState';
import { logger } from '@/lib/logger';
import { getNormalizedUserHandle } from '@oxyhq/core';

interface User {
  id: string;
  displayName?: string;
  handle: string;
  avatar?: string;
  verified: boolean;
  isFederated?: boolean;
  instance?: string;
}

/** Placeholder rows painted while the first page of engagers loads. */
const SKELETON_ROW_COUNT = 8;

interface EngagementListSheetProps {
  postId: string;
  type: 'likes' | 'boosts';
  onClose: () => void;
}

const EngagementListSheet: React.FC<EngagementListSheetProps> = ({ postId, type, onClose }) => {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);

  const loadUsers = useCallback(async (cursor?: string) => {
    try {
      if (cursor) {
        setLoadingMore(true);
      }

      const result = type === 'likes'
        ? await feedService.getPostLikes(postId, cursor)
        : await feedService.getPostBoosts(postId, cursor);

      if (cursor) {
        setUsers(prev => [...prev, ...result.users]);
      } else {
        setUsers(result.users);
      }

      setHasMore(result.hasMore);
      setNextCursor(result.nextCursor);
    } catch (error) {
      logger.error(`Error loading ${type}`);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [postId, type]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleLoadMore = useCallback(() => {
    if (hasMore && nextCursor && !loadingMore) {
      loadUsers(nextCursor);
    }
  }, [hasMore, nextCursor, loadingMore, loadUsers]);

  const handleUserPress = useCallback((user: User) => {
    onClose();
    const profileHandle = getNormalizedUserHandle({
      handle: user.handle,
      isFederated: user.isFederated,
      instance: user.instance,
    });
    if (profileHandle) {
      router.push(`/@${profileHandle}`);
    }
  }, [onClose, router]);

  const renderUser = useCallback(({ item }: { item: User }) => (
    <ProfileCard
      profile={{
        id: item.id,
        handle: item.handle,
        name: { displayName: item.displayName },
        avatar: item.avatar,
        verified: item.verified,
        isFederated: item.isFederated,
        instance: item.instance,
      }}
      showFollowButton
      onPress={() => handleUserPress(item)}
    />
  ), [handleUserPress]);

  if (loading) {
    return (
      <View className="flex-1 bg-background">
        <Header
          options={{
            title: type === 'likes' ? 'Likes' : 'Boosts',
            rightComponents: [
              <IconButton variant="icon"
                key="close"
                onPress={onClose}
              >
                <CloseIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder={true}
          disableSticky={true}
        />
        {/* The rows this list is about to paint, as placeholders. */}
        <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <Header
        options={{
          title: type === 'likes' ? 'Likes' : 'Boosts',
          rightComponents: [
            <IconButton variant="icon"
              key="close"
              onPress={onClose}
            >
              <CloseIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      {users.length === 0 ? (
        <EmptyState
          title={`No ${type === 'likes' ? 'likes' : 'boosts'} yet`}
          icon={{
            name: type === 'likes' ? 'heart-outline' : 'repeat-outline',
            size: 48,
          }}
          containerStyle={{ flex: 1 }}
        />
      ) : (
        <FlatList
          data={users}
          renderItem={renderUser}
          keyExtractor={(item) => item.id}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            loadingMore ? (
              <View className="py-4 items-center">
                <Loading className="text-primary" size="small" style={{ flex: undefined }} />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
};

export default EngagementListSheet;
