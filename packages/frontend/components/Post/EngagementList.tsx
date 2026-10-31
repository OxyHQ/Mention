import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { View, FlatList } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { feedService } from '@/services/feedService';
import { ProfileCard, ProfileCardSkeletonList } from '@/components/ProfileCard';

import { useRouter } from '@/lib/navigation/router';
import { EmptyState } from '@/components/common/EmptyState';
import { logger } from '@oxy.so/core/logger';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import type { PostUser } from '@mention/shared-types';

/** Placeholder rows painted while the first page of engagers loads. */
const SKELETON_ROW_COUNT = 8;

interface EngagementListProps {
  postId: string;
  type: 'likes' | 'boosts';
  onClose: () => void;
}

const EngagementList: React.FC<EngagementListProps> = ({ postId, type, onClose }) => {
  const router = useRouter();
  const { t } = useTranslation();
  const [users, setUsers] = useState<PostUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  // A failed first page is an error, not an empty list: "No likes yet" under a
  // counter that says otherwise reads as lost data.
  const [failed, setFailed] = useState(false);
  const title =
    type === 'likes'
      ? t('post.likesTitle', { defaultValue: 'Likes' })
      : t('post.boostsTitle', { defaultValue: 'Reposts' });

  const loadUsers = useCallback(
    async (cursor?: string) => {
      try {
        if (cursor) {
          setLoadingMore(true);
        }

        const result =
          type === 'likes'
            ? await feedService.getPostLikes(postId, cursor)
            : await feedService.getPostBoosts(postId, cursor);

        if (cursor) {
          setUsers((prev) => [...prev, ...result.users]);
        } else {
          setUsers(result.users);
        }

        setHasMore(result.hasMore);
        setNextCursor(result.nextCursor);
        setFailed(false);
      } catch (error) {
        logger.error(`Error loading ${type}`, { error });
        // A failed later page keeps the rows already shown.
        if (!cursor) setFailed(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [postId, type],
  );

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleLoadMore = useCallback(() => {
    if (hasMore && nextCursor && !loadingMore) {
      loadUsers(nextCursor);
    }
  }, [hasMore, nextCursor, loadingMore, loadUsers]);

  const handleUserPress = useCallback(
    (user: PostUser) => {
      onClose();
      const href = profileHrefForUser(user);
      if (href) {
        router.push(href);
      }
    },
    [onClose, router],
  );

  const renderUser = useCallback(
    ({ item }: { item: PostUser }) => (
      <ProfileCard
        profile={{
          id: item.id,
          username: item.username,
          name: item.name,
          avatar: item.avatar,
          verified: item.verified,
          isFederated: item.isFederated,
          kind: item.kind,
          instance: item.instance,
          federation: item.federation,
        }}
        showFollowButton
        onPress={() => handleUserPress(item)}
      />
    ),
    [handleUserPress],
  );

  if (loading) {
    return (
      <View className="flex-1 bg-background">
        <PageHeader
          title={title}
          safeArea={false}
          actions={
            <Button
              appearance="subtle"
              tone="neutral"
              iconOnly
              leadingIcon={RiCloseLine}
              accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
              onPress={onClose}
            />
          }
        />
        {/* The rows this list is about to paint, as placeholders. */}
        <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        title={title}
        safeArea={false}
        actions={
          <Button
            appearance="subtle"
            tone="neutral"
            iconOnly
            leadingIcon={RiCloseLine}
            accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
            onPress={onClose}
          />
        }
      />

      {failed ? (
        <EmptyState
          error={{
            title: t('post.engagement.loadError', { defaultValue: "Couldn't load this list" }),
            message: t('post.engagement.loadErrorMessage', {
              defaultValue: 'Check your connection and try again.',
            }),
            onRetry: () => loadUsers(),
          }}
          containerStyle={{ flex: 1 }}
        />
      ) : users.length === 0 ? (
        <EmptyState
          title={
            type === 'likes'
              ? t('post.engagement.noLikes', { defaultValue: 'No likes yet' })
              : t('post.engagement.noBoosts', { defaultValue: 'No reposts yet' })
          }
          sticker="postNoEngagement"
          containerStyle={{ flex: 1 }}
        />
      ) : (
        <FlatList
          data={users}
          renderItem={renderUser}
          keyExtractor={(item) => item.id}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={loadingMore ? <ListSkeleton count={2} /> : undefined}
        />
      )}
    </View>
  );
};

export default EngagementList;
