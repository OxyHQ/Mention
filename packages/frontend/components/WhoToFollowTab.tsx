import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import { useUsersStore } from '@/stores/usersStore';
import { useTheme } from '@/hooks/useTheme';
import LegendList from '@/components/LegendList';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';

export function WhoToFollowTab() {
  const { oxyServices } = useOxy();
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<any[]>([]);

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
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch recommendations');
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
    return (
      <View style={styles.errorContainer}>
        <ThemedText style={[styles.errorText, { color: theme.colors.error }]}>
          {t('Error')}: {error}
        </ThemedText>
        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: theme.colors.primary }]}
          onPress={() => {
            setError(null);
            const fetchRecommendations = async () => {
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
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to fetch recommendations');
              } finally {
                setLoading(false);
              }
            };
            fetchRecommendations();
          }}
        >
          <ThemedText style={styles.retryButtonText}>{t('action.retry')}</ThemedText>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <LegendList
      data={recommendations}
      renderItem={renderUser}
      keyExtractor={(item: any) => String(item.id || item._id || item.username)}
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
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch recommendations');
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
});

