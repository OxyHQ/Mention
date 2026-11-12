import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Screen } from '@oxy.so/bloom/screen';
import { VirtualList } from '@oxy.so/bloom/list';
import type { Href } from '@/lib/navigation/router';
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
  onNavigate?: (href: Href) => void;
}

const EngagementList: React.FC<EngagementListProps> = ({ postId, type, onClose, onNavigate }) => {
  const router = useRouter();
  const { t } = useTranslation();
  const requestGeneration = useRef(0);
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
      const generation = requestGeneration.current;
      try {
        if (cursor) {
          setLoadingMore(true);
        }

        const result =
          type === 'likes'
            ? await feedService.getPostLikes(postId, cursor)
            : await feedService.getPostBoosts(postId, cursor);

        if (generation !== requestGeneration.current) return;
        if (cursor) {
          setUsers((prev) => [...prev, ...result.users]);
        } else {
          setUsers(result.users);
        }

        setHasMore(result.hasMore);
        setNextCursor(result.nextCursor);
        setFailed(false);
      } catch (error) {
        if (generation !== requestGeneration.current) return;
        logger.error(`Error loading ${type}`, error);
        // A failed later page keeps the rows already shown.
        if (!cursor) setFailed(true);
      } finally {
        if (generation === requestGeneration.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [postId, type],
  );

  useEffect(() => {
    void loadUsers();
    return () => {
      requestGeneration.current += 1;
    };
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
        if (onNavigate) onNavigate(href);
        else router.push(href);
      }
    },
    [onClose, onNavigate, router],
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

  return (
    <Screen
      header={
        <PageHeader
          title={title}
          onBack={null}
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
      }
    >
      <VirtualList
        screen={{}}
        data={loading || failed ? [] : users}
        renderItem={renderUser}
        keyExtractor={(item) => item.id}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loadingMore ? <ListSkeleton count={2} /> : undefined}
        ListEmptyComponent={
          loading ? (
            <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton />
          ) : failed ? (
            <EmptyState
              error={{
                title: t('post.engagement.loadError', { defaultValue: "Couldn't load this list" }),
                message: t('post.engagement.loadErrorMessage', {
                  defaultValue: 'Check your connection and try again.',
                }),
                onRetry: () => loadUsers(),
              }}
            />
          ) : (
            <EmptyState
              title={
                type === 'likes'
                  ? t('post.engagement.noLikes', { defaultValue: 'No likes yet' })
                  : t('post.engagement.noBoosts', { defaultValue: 'No reposts yet' })
              }
              sticker="postNoEngagement"
            />
          )
        }
      />
    </Screen>
  );
};

export default EngagementList;
