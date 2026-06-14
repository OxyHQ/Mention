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

const APP_URL = 'https://mention.earth';

/**
 * A single recommended profile.
 *
 * Derived from the SDK's `getProfileRecommendations` return type so it stays in
 * lockstep with the source of truth, intersected with the extra fields the API's
 * `formatProfileResult` actually returns (`avatar`) and the looser `_id`/`bio`
 * variants that may appear when items come from other actor sources.
 */
type RecommendedUser = Awaited<
  ReturnType<ReturnType<typeof useAuth>['oxyServices']['getProfileRecommendations']>
>[number] & {
  _id?: string;
  avatar?: string;
  bio?: string;
};

/**
 * The `/profiles/recommendations` endpoint returns the standardized
 * `sendSuccess` envelope (`{ data: [...] }`), which the SDK's HttpService
 * unwraps to a bare array before it reaches us. We still normalize defensively
 * so the tab is correct regardless of whether the value arrives unwrapped, as a
 * `{ data }` envelope, or as a `{ recommendations }` envelope.
 */
function extractRecommendations(response: unknown): RecommendedUser[] {
  if (Array.isArray(response)) {
    return response as RecommendedUser[];
  }
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      return record.data as RecommendedUser[];
    }
    if (Array.isArray(record.recommendations)) {
      return record.recommendations as RecommendedUser[];
    }
  }
  return [];
}

/** Resolve a user's id from either the canonical `id` or Mongo `_id`. */
function getUserId(user: Pick<RecommendedUser, 'id' | '_id'>): string {
  return String(user.id ?? user._id ?? '');
}

export function WhoToFollowTab() {
  const { oxyServices, user } = useAuth();
  const { t } = useTranslation();
  const theme = useTheme();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendedUser[]>([]);

  const getInviteMessage = useCallback(() => {
    const userName = user
      ? typeof user.name === 'string'
        ? user.name
        : user.name?.full || user.name?.first || user.username
      : 'Someone';
    const userHandle = user?.username || '';

    if (userHandle) {
      return t('settings.inviteContacts.shareMessageWithHandle', {
        name: userName,
        handle: userHandle,
        url: APP_URL,
      });
    }
    return t('settings.inviteContacts.shareMessage', {
      name: userName,
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
      const response = await oxyServices.getProfileRecommendations();
      const users = extractRecommendations(response).filter((u) => getUserId(u).length > 0);
      setRecommendations(users);
      if (users.length > 0) {
        precacheProfileViews(queryClient, users);
        // Fire-and-forget: missing avatars fill in reactively via useUserById.
        void enrichMissingAvatars(
          users.map((u) => ({ ...u, id: getUserId(u) })),
          (id) => oxyServices.getUserById(id),
          queryClient,
        );
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch recommendations';
      setError(errorMessage);
      logger.error('Error fetching recommendations');
    } finally {
      setLoading(false);
    }
  }, [oxyServices]);

  useEffect(() => {
    fetchAndEnrich();
  }, [fetchAndEnrich]);

  const renderUser = useCallback(({ item }: { item: RecommendedUser }) => {
    const id = getUserId(item);
    if (!id) return null;
    return <FollowRow item={item} userId={id} />;
  }, []);

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

  const renderInviteBanner = () => (
    <TouchableOpacity
      className="bg-card border-border"
      style={styles.inviteBanner}
      onPress={handleInviteFriends}
      activeOpacity={0.7}
    >
      <View className="bg-primary" style={styles.inviteIconContainer}>
        <Ionicons name="people" size={20} color={theme.colors.card} />
      </View>
      <View style={styles.inviteContent}>
        <ThemedText className="text-foreground" style={styles.inviteTitle}>
          {t('settings.inviteContacts.inviteBannerTitle')}
        </ThemedText>
        <ThemedText className="text-muted-foreground" style={styles.inviteSubtitle}>
          {t('settings.inviteContacts.inviteBannerSubtitle')}
        </ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  );

  return (
    <LegendList
      data={recommendations}
      renderItem={renderUser}
      keyExtractor={(item: RecommendedUser) => getUserId(item) || item.username}
      ListHeaderComponent={renderInviteBanner}
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
      contentContainerStyle={styles.listContent}
      refreshing={loading}
      onRefresh={fetchAndEnrich}
    />
  );
}

const FollowRow = React.memo(({ item, userId }: { item: RecommendedUser; userId: string }) => {
  const router = useRouter();
  const cachedUser = useUserById(userId);

  const displayName = useMemo(() => {
    if (item.name?.full) return item.name.full;
    if (item.name?.first) {
      return `${item.name.first} ${item.name.last || ''}`.trim();
    }
    return item.username || 'Unknown User';
  }, [item.name, item.username]);

  const avatarUri = item.avatar || cachedUser?.avatar;
  const username = item.username || userId;

  const handlePress = useCallback(() => {
    router.push(`/@${username}`);
  }, [router, username]);

  return (
    <View className="border-border" style={styles.row}>
      <TouchableOpacity
        style={styles.rowLeft}
        onPress={handlePress}
        activeOpacity={0.7}
      >
        <Avatar source={avatarUri} size={48} />
        <View style={styles.rowTextWrap}>
          <ThemedText className="text-foreground" style={styles.rowTitle}>
            {displayName}
          </ThemedText>
          <ThemedText className="text-muted-foreground" style={styles.rowSub}>
            @{username}
          </ThemedText>
          {item.bio ? (
            <ThemedText className="text-muted-foreground" style={styles.rowBio} numberOfLines={2}>
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
    paddingVertical: 12,
    paddingHorizontal: 16,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  rowTextWrap: {
    marginLeft: 12,
    flex: 1,
  },
  rowTitle: {
    fontWeight: '600',
    fontSize: 16,
  },
  rowSub: {
    paddingTop: 2,
    fontSize: 14,
  },
  rowBio: {
    paddingTop: 4,
    fontSize: 14,
    lineHeight: 18,
  },
  inviteBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 20,
    borderWidth: 1,
    gap: 10,
  },
  inviteIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteContent: {
    flex: 1,
  },
  inviteTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 2,
  },
  inviteSubtitle: {
    fontSize: 13,
    fontWeight: '500',
  },
});
