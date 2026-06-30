import React, { useCallback, useMemo } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View, Share } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { useAuth, FollowButton } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';

import { useUserById } from '@/hooks/useCachedUser';
import { useTheme } from '@oxyhq/bloom/theme';
import { VirtualList } from '@oxyhq/bloom/list';
import { ThemedText } from '@/components/ThemedText';
import { Ionicons } from '@expo/vector-icons';
import { Error as ErrorDisplay } from '@/components/Error';
import { LoadMoreSentinel } from '@/components/common/LoadMoreSentinel';
import { logger } from '@/lib/logger';
import { useInfiniteRecommendations } from '@/hooks/useRecommendations';
import { type ProfileData } from '@/lib/recommendations';
import { getNormalizedUserHandle } from '@oxyhq/core';

const APP_URL = 'https://mention.earth';

interface WhoToFollowTabProps {
  /**
   * Optional header element rendered above the invite banner inside the list,
   * so it scrolls away with the content — identical to the Feed-backed tabs,
   * which pass the same trends strip as the Feed's `listHeaderComponent`.
   */
  listHeaderComponent?: React.ReactElement;
}

export function WhoToFollowTab({ listHeaderComponent }: WhoToFollowTabProps = {}) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const theme = useTheme();

  // Cursor-paginated recommendations: this tab loads more on scroll-end. The
  // single-page `useRecommendations` still backs the widgets; this infinite
  // variant shares the same fetch/precache/enrich core and dedups by id.
  const {
    recommendations,
    isLoading: loading,
    error,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteRecommendations();

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Footer carries BOTH the web load-more trigger (Bloom's web VirtualList is a
  // window virtualizer with no `onEndReached`) and the next-page spinner. On
  // native the list paginates via `onEndReached`; the sentinel is inert there.
  const renderFooter = useCallback(
    () => (
      <View style={styles.footer}>
        <LoadMoreSentinel onLoadMore={handleLoadMore} enabled={hasNextPage} />
        {isFetchingNextPage ? <Loading className="text-primary" size="small" /> : null}
      </View>
    ),
    [handleLoadMore, hasNextPage, isFetchingNextPage],
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

  const renderUser = useCallback(({ item }: { item: ProfileData }) => {
    if (!item.id) return null;
    return <FollowRow item={item} userId={item.id} />;
  }, []);

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
            <Ionicons name="people" size={18} color={theme.colors.card} />
          </View>
          <View style={styles.inviteContent}>
            <ThemedText className="text-foreground" style={styles.inviteTitle}>
              {t('settings.inviteContacts.inviteBannerTitle')}
            </ThemedText>
            <ThemedText className="text-muted-foreground" style={styles.inviteSubtitle}>
              {t('settings.inviteContacts.inviteBannerSubtitle')}
            </ThemedText>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
        </TouchableOpacity>
      </>
    ),
    [listHeaderComponent, handleInviteFriends, theme.colors.card, theme.colors.textSecondary, t],
  );

  if (loading && recommendations.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <Loading className="text-primary" size="large" />
        <ThemedText className="text-muted-foreground" style={styles.loadingText}>
          {t('Loading...')}
        </ThemedText>
      </View>
    );
  }

  if (error && recommendations.length === 0) {
    return (
      <ErrorDisplay
        title={t('Error', { defaultValue: 'Error' })}
        message={error.message}
        onRetry={refetch}
        hideBackButton={true}
        style={styles.errorContainer}
      />
    );
  }

  return (
    <View className="flex-1 bg-background" style={styles.container}>
      <VirtualList
        data={recommendations}
        renderItem={renderUser}
        keyExtractor={(item: ProfileData) => item.id || item.username || ''}
        ListHeaderComponent={listHeader}
        ListFooterComponent={renderFooter}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <ThemedText className="text-muted-foreground">
              {t('No recommendations available')}
            </ThemedText>
          </View>
        }
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

const FollowRow = React.memo(({ item, userId }: { item: ProfileData; userId: string }) => {
  const router = useRouter();
  const cachedUser = useUserById(userId);

  const username = item.username || cachedUser?.username || '';
  const instance = item.instance || item.federation?.domain;
  const handle = getNormalizedUserHandle({
    username,
    instance,
    isFederated: item.isFederated,
  });

  const handlePress = useCallback(() => {
    if (handle) {
      router.push(`/@${handle}`);
    }
  }, [router, handle]);

  return (
    <View className="border-border" style={styles.row}>
      <TouchableOpacity
        style={styles.rowLeft}
        onPress={handlePress}
        disabled={!handle}
        activeOpacity={0.7}
      >
        <Avatar source={item.avatar || cachedUser?.avatar} size={40} variant="thumb" />
        <View style={styles.rowTextWrap}>
          <ThemedText className="text-foreground" style={styles.rowTitle}>
            {item.name.displayName}
          </ThemedText>
          {handle ? (
            <ThemedText className="text-muted-foreground" style={styles.rowSub}>
              @{handle}
            </ThemedText>
          ) : null}
          {item.bio ? (
            <ThemedText className="text-muted-foreground" style={styles.rowBio} numberOfLines={1}>
              {item.bio}
            </ThemedText>
          ) : null}
        </View>
      </TouchableOpacity>
      <FollowButton userId={userId} size="small" />
    </View>
  );
});
FollowRow.displayName = 'FollowRow';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  loadingText: {
    fontSize: 16,
  },
  errorContainer: {
    flex: 1,
    paddingVertical: 40,
  },
  emptyContainer: {
    padding: 40,
    alignItems: 'center',
  },
  listContent: {
    paddingBottom: 20,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 0.5,
    paddingVertical: 8,
    paddingHorizontal: 16,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  rowTextWrap: {
    marginLeft: 10,
    flex: 1,
  },
  rowTitle: {
    fontWeight: '600',
    fontSize: 15,
  },
  rowSub: {
    paddingTop: 2,
    fontSize: 13,
  },
  rowBio: {
    paddingTop: 2,
    fontSize: 13,
    lineHeight: 17,
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
