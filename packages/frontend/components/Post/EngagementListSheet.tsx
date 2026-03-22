import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import { feedService } from '@/services/feedService';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MentionAvatarIcon } from '@/components/MentionAvatarIcon';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { EmptyState } from '@/components/common/EmptyState';
import { logger } from '@/lib/logger';

interface User {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  verified: boolean;
}

interface EngagementListSheetProps {
  postId: string;
  type: 'likes' | 'reposts';
  onClose: () => void;
}

const EngagementListSheet: React.FC<EngagementListSheetProps> = ({ postId, type, onClose }) => {
  const theme = useTheme();
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
        : await feedService.getPostReposts(postId, cursor);

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

  const handleUserPress = useCallback((handle: string) => {
    onClose();
    router.push(`/@${handle}`);
  }, [onClose, router]);

  const renderUser = useCallback(({ item }: { item: User }) => {
    return (
      <TouchableOpacity
        className="flex-row items-center px-4 py-3"
        style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'transparent' }}
        onPress={() => handleUserPress(item.handle)}
      >
        <Avatar source={item.avatar} size={50} style={{ marginRight: 12 }}  placeholderIcon={<MentionAvatarIcon size={50 * 0.6} />} />
        <View className="flex-1">
          <View className="flex-row items-center">
            <Text className="text-foreground text-base font-semibold" numberOfLines={1}>
              {item.name}
            </Text>
            {item.verified && (
              <Ionicons name="checkmark-circle" size={16} color={theme.colors.primary} style={{ marginLeft: 4 }} />
            )}
          </View>
          <Text className="text-muted-foreground text-sm mt-0.5" numberOfLines={1}>
            @{item.handle}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
      </TouchableOpacity>
    );
  }, [theme, handleUserPress]);

  if (loading) {
    return (
      <View className="flex-1 bg-background">
        <Header
          options={{
            title: type === 'likes' ? 'Likes' : 'Reposts',
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
        <View className="flex-1 justify-center items-center">
          <Loading size="large" />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <Header
        options={{
          title: type === 'likes' ? 'Likes' : 'Reposts',
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
          title={`No ${type === 'likes' ? 'likes' : 'reposts'} yet`}
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
                <Loading size="small" style={{ flex: undefined }} />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
};

export default EngagementListSheet;
