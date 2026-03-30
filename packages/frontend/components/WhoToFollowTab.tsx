import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View, Share } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';

import { useUsersStore, useUserById } from '@/stores/usersStore';
import { enrichMissingAvatars } from '@/utils/userEnrichment';
import { useTheme } from '@oxyhq/bloom/theme';
import LegendList from '@/components/LegendList';
import { ThemedText } from '@/components/ThemedText';
import { Ionicons } from '@expo/vector-icons';
import { Error as ErrorDisplay } from '@/components/Error';
import { logger } from '@/lib/logger';

export function WhoToFollowTab() {
  const { oxyServices, user } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<any[]>([]);

  const getInviteMessage = useCallback(() => {
    const userName = user
      ? typeof user.name === 'string'
        ? user.name
        : user.name?.full || user.name?.first || user.username
      : 'Someone';
    const userHandle = user?.username || '';
    const appUrl = 'https://mention.earth';
    
    // Use a more engaging invite message with proper translation
    if (userHandle) {
      return t('settings.inviteContacts.shareMessageWithHandle', {
        name: userName,
        handle: userHandle,
        url: appUrl,
      });
    } else {
      return t('settings.inviteContacts.shareMessage', {
        name: userName,
        url: appUrl,
      });
    }
  }, [user, t]);

  const handleInviteFriends = useCallback(async () => {
    const inviteMessage = getInviteMessage();
    const appUrl = 'https://mention.earth';

    if (Platform.OS === 'web') {
      // On web, use Share API or copy to clipboard
      if (navigator.share) {
        try {
          await navigator.share({
            title: t('settings.inviteContacts.inviteTitle'),
            text: inviteMessage,
            url: appUrl,
          });
        } catch (e) {
          // User cancelled or error
        }
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(inviteMessage);
        // Could show a toast here
      }
      return;
    }

    try {
      // Use Share API - ensure message is always included
      // The message already contains the URL, so we don't need to add it separately
      const shareOptions: any = {
        message: inviteMessage, // Full message with URL already included
      };
      
      // On iOS, we can optionally add title, but message should be primary
      if (Platform.OS === 'ios') {
        // Don't set title as it might override the message in some apps
        // Just use message which contains everything
      }
      
      await Share.share(shareOptions);
    } catch (error: unknown) {
      const err = error as { message?: string; code?: string };
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
      const users = Array.isArray(response) ? response : [];
      setRecommendations(users);
      if (users.length > 0) {
        try {
          useUsersStore.getState().upsertMany(users as any);
        } catch { }
        // Fire-and-forget: avatars fill in reactively via useUserById
        void enrichMissingAvatars(users, (id) => oxyServices.getUserById(id));
      }
    } catch (err: unknown) {
      let errorMessage = 'Failed to fetch recommendations';
      if (err instanceof Error) {
        errorMessage = err.message;
      }
      setError(errorMessage);
      logger.error('Error fetching recommendations');
    } finally {
      setLoading(false);
    }
  }, [oxyServices]);

  useEffect(() => {
    fetchAndEnrich();
  }, [fetchAndEnrich]);

  const renderUser = useCallback(({ item }: { item: any }) => {
    if (!item?.id) return null;
    return <FollowRow item={item} />;
  }, []);

  if (loading && recommendations.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <Loading size="large" />
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
        style={{ flex: 1, paddingVertical: 40 }}
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
      keyExtractor={(item: any) => String(item.id || item._id || item.username)}
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

const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string; size?: 'small' | 'medium' | 'large' }>;

const FollowRow = React.memo(({ item }: { item: any }) => {
  const router = useRouter();
  const cachedUser = useUserById(item.id);

  const displayName = useMemo(() => {
    if (item.name?.full) return item.name.full;
    if (item.name?.first) {
      return `${item.name.first} ${item.name.last || ''}`.trim();
    }
    return item.username || 'Unknown User';
  }, [item.name, item.username]);

  const avatarUri = item.avatar || cachedUser?.avatar;
  const username = item.username || item.id;

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
          {item.bio && (
            <ThemedText className="text-muted-foreground" style={styles.rowBio} numberOfLines={2}>
              {item.bio}
            </ThemedText>
          )}
        </View>
      </TouchableOpacity>
      <FollowButton userId={item.id} size="small" />
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

