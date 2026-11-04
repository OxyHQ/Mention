import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import React, { useCallback, useMemo } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View, Share } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';

import { useCachedUserSnapshot } from '@/hooks/useCachedUser';
import { useTheme } from '@oxy.so/bloom/theme';
import { VirtualList } from '@oxy.so/bloom/list';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiGroupFill } from '@oxy.so/bloom/icons/RiGroupFill';
import {
  ProfileCard,
  ProfileCardSkeletonList,
  type ProfileCardData,
} from '@/components/ProfileCard';
import { Error as ErrorDisplay } from '@/components/Error';
import { EmptyState } from '@/components/common/EmptyState';
import { logger } from '@oxy.so/core/logger';
import {
  useInfiniteNewestUsers,
  useInfiniteRecommendations,
  type UseInfiniteRecommendationsResult,
} from '@/hooks/useRecommendations';
import type { ProfileData } from '@/lib/recommendations';

const APP_URL = 'https://mention.earth';

/** Placeholder rows painted while the first page of recommendations loads. */
const SKELETON_ROW_COUNT = 8;

export interface WhoToFollowTabProps {
  /**
   * Optional header element rendered above the invite banner inside the list,
   * so it scrolls away with the content — identical to the Feed-backed tabs,
   * which pass the same trends strip as the Feed's `listHeaderComponent`.
   */
  listHeaderComponent?: React.ReactElement;
}

/** Explore › Who to follow: recommended accounts for the viewer. */
export function WhoToFollowTab({ listHeaderComponent }: WhoToFollowTabProps = {}) {
  const { t } = useTranslation();
  const query = useInfiniteRecommendations();
  return (
    <ProfileDiscoveryList
      query={query}
      emptyTitle={t('connections.emptyRecommendations')}
      // Recommendations never include anyone the viewer follows (Oxy's
      // contract), so each button starts at Follow instead of asking.
      excludesFollowed
      listHeaderComponent={listHeaderComponent}
    />
  );
}

/** Explore › Who to follow › New: the newest people, in sign-up order. */
export function NewUsersTab() {
  const { t } = useTranslation();
  const query = useInfiniteNewestUsers();
  return (
    <ProfileDiscoveryList
      query={query}
      emptyTitle={t('explore.newPeople.empty')}
      excludesFollowed={false}
    />
  );
}

interface ProfileDiscoveryListProps extends WhoToFollowTabProps {
  query: UseInfiniteRecommendationsResult;
  emptyTitle: string;
  /** The list never holds someone the viewer follows, so no row asks. */
  excludesFollowed: boolean;
}

function ProfileDiscoveryList({
  query,
  emptyTitle,
  excludesFollowed,
  listHeaderComponent,
}: ProfileDiscoveryListProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const theme = useTheme();

  const {
    recommendations,
    isLoading: loading,
    error,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = query;

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // The next page's skeleton; the list itself asks for that page (`onEndReached`).
  const renderFooter = useCallback(
    () => (
      <View style={styles.footer}>{isFetchingNextPage ? <ListSkeleton count={2} /> : null}</View>
    ),
    [isFetchingNextPage],
  );

  const getInviteMessage = useCallback(() => {
    const userHandle = user?.username || '';

    if (userHandle) {
      return t('settings.inviteContacts.shareMessageWithHandle', {
        name: user?.name.displayName ?? 'Someone',
        handle: userHandle,
        url: APP_URL,
      });
    }
    return t('settings.inviteContacts.shareMessage', {
      name: user?.name.displayName ?? 'Someone',
      url: APP_URL,
    });
  }, [user, t]);

  const handleInviteFriends = useCallback(async () => {
    const inviteMessage = getInviteMessage();

    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && navigator.share) {
        try {
          await navigator.share({
            title: t('settings.inviteContacts.inviteTitle'),
            text: inviteMessage,
            url: APP_URL,
          });
        } catch (e: unknown) {
          // AbortError = user dismissed the native share sheet; not an error.
          if (e instanceof Error && e.name !== 'AbortError') {
            logger.error('Error inviting friends');
          }
        }
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(inviteMessage);
      }
      return;
    }

    try {
      // The message already contains the URL, so it carries everything needed.
      await Share.share({ message: inviteMessage });
    } catch (e: unknown) {
      const err = e as { message?: string; code?: string };
      if (err?.message !== 'User did not share' && err?.code !== 'ERR_SHARE_CANCELLED') {
        logger.error('Error inviting friends');
      }
    }
  }, [getInviteMessage, t]);

  const renderUser = useCallback(
    ({ item }: { item: ProfileData }) => {
      if (!item.id) return null;
      return <FollowRow item={item} userId={item.id} excludesFollowed={excludesFollowed} />;
    },
    [excludesFollowed],
  );

  const listHeader = useMemo(
    () => (
      <>
        {listHeaderComponent}
        <TouchableOpacity
          className="bg-card border-border"
          style={styles.inviteBanner}
          onPress={handleInviteFriends}
          activeOpacity={0.7}
        >
          <View className="bg-primary" style={styles.inviteIconContainer}>
            <RiGroupFill width={18} fill={theme.colors.card} />
          </View>
          <View style={styles.inviteContent}>
            <Text className="leading-6 text-foreground" style={styles.inviteTitle}>
              {t('settings.inviteContacts.inviteBannerTitle')}
            </Text>
            <Text className="leading-6 text-muted-foreground" style={styles.inviteSubtitle}>
              {t('settings.inviteContacts.inviteBannerSubtitle')}
            </Text>
          </View>
          <RiArrowRightSLine width={18} fill={theme.colors.textSecondary} />
        </TouchableOpacity>
      </>
    ),
    [listHeaderComponent, handleInviteFriends, theme.colors.card, theme.colors.textSecondary, t],
  );

  // The first load paints the row skeletons (the list header stays put), so the
  // tab never swaps a centered spinner for a list and reflows.
  if (loading && recommendations.length === 0) {
    return (
      <View className="flex-1">
        {listHeader}
        <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton />
      </View>
    );
  }

  if (error && recommendations.length === 0) {
    return (
      <ErrorDisplay
        title={t('common.error', { defaultValue: 'Error' })}
        message={error.message}
        onRetry={refetch}
        hideBackButton={true}
        style={styles.errorContainer}
      />
    );
  }

  return (
    <View className="flex-1" style={styles.container}>
      <VirtualList
        screen={{}}
        data={recommendations}
        renderItem={renderUser}
        keyExtractor={(item: ProfileData) => item.id || item.username || ''}
        ListHeaderComponent={listHeader}
        ListFooterComponent={renderFooter}
        ListEmptyComponent={<EmptyState title={emptyTitle} sticker="connectionsRecommendations" />}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        removeClippedSubviews={false}
        maxToRenderPerBatch={10}
        windowSize={10}
        initialNumToRender={10}
        recycleItems={true}
        maintainVisibleContentPosition={true}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshing={isRefetching}
        onRefresh={refetch}
      />
    </View>
  );
}

/**
 * A discovery row. The cached user fills in the fields the payload can omit (an
 * avatar the batched enrichment found), without a fetch of its own per row; the
 * shared {@link ProfileCard} renders the row and owns the follow button.
 */
const FollowRow = React.memo(function FollowRow({
  item,
  userId,
  excludesFollowed,
}: {
  item: ProfileData;
  userId: string;
  excludesFollowed: boolean;
}) {
  const cachedUser = useCachedUserSnapshot(userId);

  const profile: ProfileCardData = {
    id: userId,
    username: item.username || cachedUser?.username || '',
    name: item.name,
    avatar: item.avatar || cachedUser?.avatar,
    color: item.color ?? cachedUser?.color,
    verified: item.verified,
    description: item.bio,
    isFederated: item.isFederated,
    isAgent: item.isAgent,
    isAutomated: item.isAutomated,
    instance: item.instance,
    federation: item.federation,
  };

  return (
    <ProfileCard
      profile={profile}
      showFollowButton
      initiallyFollowing={excludesFollowed ? false : undefined}
    />
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  errorContainer: {
    flex: 1,
    paddingVertical: 40,
  },
  listContent: {
    paddingBottom: 20,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  inviteBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 20,
    borderWidth: 1,
    gap: 10,
  },
  inviteIconContainer: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteContent: {
    flex: 1,
  },
  inviteTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  inviteSubtitle: {
    fontSize: 12,
    fontWeight: '500',
  },
});
