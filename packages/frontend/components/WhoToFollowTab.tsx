import React, { useEffect, useState, useCallback } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View, Share, Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import { useUsersStore } from '@/stores/usersStore';
import { useTheme } from '@/hooks/useTheme';
import LegendList from '@/components/LegendList';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import { Error } from '@/components/Error';

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
        console.error('Error inviting friends:', error);
      }
    }
  }, [getInviteMessage, t]);

  useEffect(() => {
    const fetchRecommendations = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await oxyServices.getProfileRecommendations();
        const recommendationsList = Array.isArray(response) ? response : [];
        setRecommendations(recommendationsList);
        try {
          if (recommendationsList.length) {
            useUsersStore.getState().upsertMany(recommendationsList as any);
          }
        } catch { }
      } catch (err: unknown) {
        let errorMessage = 'Failed to fetch recommendations';
        if (err instanceof Error) {
          errorMessage = err.message;
        }
        setError(errorMessage);
        console.error('Error fetching recommendations:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchRecommendations();
  }, [oxyServices]);

  const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string; size?: 'small' | 'medium' | 'large' }>;

  const renderUser = ({ item }: { item: any }) => {
    if (!item?.id) return null;

    const displayName = item.name?.first
      ? `${item.name.first} ${item.name.last || ''}`.trim()
      : item.username || 'Unknown User';

    const avatarUri = item?.avatar
      ? oxyServices.getFileDownloadUrl(item.avatar as string, 'thumb')
      : undefined;
    const username = item.username || item.id;

    return (
      <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          style={styles.rowLeft}
          onPress={() => router.push(`/@${username}`)}
          activeOpacity={0.7}
        >
          <Avatar source={avatarUri} size={48} />
          <View style={styles.rowTextWrap}>
            <ThemedText style={[styles.rowTitle, { color: theme.colors.text }]}>
              {displayName}
            </ThemedText>
            <ThemedText style={[styles.rowSub, { color: theme.colors.textSecondary }]}>
              @{username}
            </ThemedText>
            {item.bio && (
              <ThemedText style={[styles.rowBio, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                {item.bio}
              </ThemedText>
            )}
          </View>
        </TouchableOpacity>
        <FollowButton userId={item.id} size="small" />
      </View>
    );
  };

  if (loading && recommendations.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <ThemedText style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
          {t('Loading...')}
        </ThemedText>
      </View>
    );
  }

  if (error && recommendations.length === 0) {
    const handleRetry = async () => {
            setError(null);
              try {
                setLoading(true);
                const response = await oxyServices.getProfileRecommendations();
                const recommendationsList = Array.isArray(response) ? response : [];
                setRecommendations(recommendationsList);
                try {
                  if (recommendationsList.length) {
                    useUsersStore.getState().upsertMany(recommendationsList as any);
                  }
                } catch { }
      } catch (err: unknown) {
        let errorMessage = 'Failed to fetch recommendations';
        if (err instanceof Error) {
          errorMessage = err.message;
        }
        setError(errorMessage);
              } finally {
                setLoading(false);
              }
            };

    return (
      <Error
        title={t('Error', { defaultValue: 'Error' })}
        message={error}
        onRetry={handleRetry}
        hideBackButton={true}
        style={{ flex: 1, paddingVertical: 40 }}
      />
    );
  }

  const renderInviteBanner = () => (
    <TouchableOpacity
      style={[styles.inviteBanner, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}
      onPress={handleInviteFriends}
      activeOpacity={0.7}
    >
      <View style={[styles.inviteIconContainer, { backgroundColor: theme.colors.primary }]}>
        <Ionicons name="people" size={20} color={theme.colors.card} />
      </View>
      <View style={styles.inviteContent}>
        <ThemedText style={[styles.inviteTitle, { color: theme.colors.text }]}>
          {t('settings.inviteContacts.inviteBannerTitle')}
        </ThemedText>
        <ThemedText style={[styles.inviteSubtitle, { color: theme.colors.textSecondary }]}>
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
          <ThemedText style={{ color: theme.colors.textSecondary }}>
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
      onRefresh={() => {
        const fetchRecommendations = async () => {
          try {
            setLoading(true);
            setError(null);
            const response = await oxyServices.getProfileRecommendations();
            const recommendationsList = Array.isArray(response) ? response : [];
            setRecommendations(recommendationsList);
            try {
              if (recommendationsList.length) {
                useUsersStore.getState().upsertMany(recommendationsList as any);
              }
            } catch { }
          } catch (err: unknown) {
            let errorMessage = 'Failed to fetch recommendations';
            if (err instanceof Error) {
              errorMessage = err.message;
            }
            setError(errorMessage);
          } finally {
            setLoading(false);
          }
        };
        fetchRecommendations();
      }}
    />
  );
}

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
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
    gap: 16,
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
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

