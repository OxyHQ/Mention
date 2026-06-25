import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View, Share } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { useAuth, FollowButton } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';

import { useUserById } from '@/hooks/useCachedUser';
import { queryClient } from '@/lib/queryClient';
import { precacheProfileViews } from '@/lib/precacheProfiles';
import { enrichMissingAvatars } from '@/utils/userEnrichment';
import { useTheme } from '@oxyhq/bloom/theme';
import LegendList from '@/components/LegendList';
import { ThemedText } from '@/components/ThemedText';
import { Ionicons } from '@expo/vector-icons';
import { Error as ErrorDisplay } from '@/components/Error';
import { logger } from '@/lib/logger';
import { fetchRecommendations, type ProfileData } from '@/lib/recommendations';
import { isAuthError } from '@/utils/authErrors';
import { getNormalizedUserHandle } from '@oxyhq/core';

const APP_URL = 'https://mention.earth';

/**
 * A single recommended profile from the Mention backend. The shared
 * {@link ProfileData} is the source of truth; we keep the looser `_id` variant
 * that may appear when items come from other actor sources.
 */
type RecommendedUser = ProfileData & {
  _id?: string;
};

/** Resolve a user's id from either the canonical `id` or Mongo `_id`. */
function getUserId(user: Pick<RecommendedUser, 'id' | '_id'>): string {
  return String(user.id ?? user._id ?? '');
}

interface WhoToFollowTabProps {
  /**
   * Optional header element rendered above the invite banner inside the list,
   * so it scrolls away with the content — identical to the Feed-backed tabs,
   * which pass the same trends strip as the Feed's `listHeaderComponent`.
   */
  listHeaderComponent?: React.ReactElement;
}

export function WhoToFollowTab({ listHeaderComponent }: WhoToFollowTabProps = {}) {
  const { oxyServices, user } = useAuth();
  const { t } = useTranslation();
  const theme = useTheme();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendedUser[]>([]);

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

  const fetchAndEnrich = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const users = (await fetchRecommendations()).filter((u) => getUserId(u).length > 0);
      setRecommendations(users);
      if (users.length > 0) {
        precacheProfileViews(queryClient, users);
        // Fire-and-forget: missing avatars fill in reactively via useUserById.
        void enrichMissingAvatars(
          users.map((u) => ({ ...u, id: getUserId(u) })),
          (ids) => oxyServices.getUsersByIds(ids),
          queryClient,
        );
      }
    } catch (err: unknown) {
      // Recommendations are public; on the rare auth error keep `error` null so
      // the empty state shows instead of a scary red error for logged-out users.
      if (isAuthError(err)) {
        logger.warn('WhoToFollowTab: auth error fetching recommendations, showing empty state');
      } else {
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch recommendations';
        setError(errorMessage);
        logger.error('Error fetching recommendations');
      }
    } finally {
      setLoading(false);
    }
    // `user?.id` is in the deps so the callback identity changes when the auth
    // session resolves on cold boot. Without it, `oxyServices` is a stable
    // singleton and the effect below fires once while anonymous, never
    // refetching the personalized recommendations after sign-in lands.
  }, [oxyServices, user?.id]);

  useEffect(() => {
    fetchAndEnrich();
  }, [fetchAndEnrich]);

  const renderUser = useCallback(({ item }: { item: RecommendedUser }) => {
    const id = getUserId(item);
    if (!id) return null;
    return <FollowRow item={item} userId={id} />;
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
        message={error}
        onRetry={fetchAndEnrich}
        hideBackButton={true}
        style={styles.errorContainer}
      />
    );
  }

  return (
    <View className="flex-1 bg-background" style={styles.container}>
      <LegendList
        data={recommendations}
        renderItem={renderUser}
        keyExtractor={(item: RecommendedUser) => getUserId(item) || item.username || ''}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <ThemedText className="text-muted-foreground">
              {t('No recommendations available')}
            </ThemedText>
          </View>
        }
        removeClippedSubviews={false}
        maxToRenderPerBatch={10}
        windowSize={10}
        initialNumToRender={10}
        recycleItems={true}
        maintainVisibleContentPosition={true}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshing={loading}
        onRefresh={fetchAndEnrich}
      />
    </View>
  );
}

const FollowRow = React.memo(({ item, userId }: { item: RecommendedUser; userId: string }) => {
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
        <Avatar source={item.avatar || cachedUser?.avatar} size={40} />
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
