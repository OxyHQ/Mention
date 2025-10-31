import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import * as OxyServicesNS from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import { BaseWidget } from './BaseWidget';
import { useUsersStore } from '@/stores/usersStore';
import { useTheme } from '@/hooks/useTheme';

export function WhoToFollowWidget() {
  const { oxyServices } = useOxy();
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<any[] | null>(null);

  useEffect(() => {
    const fetchRecommendations = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await oxyServices.getProfileRecommendations();
        setRecommendations(response || []);
        try {
          if (Array.isArray(response) && response.length) {
            useUsersStore.getState().upsertMany(response as any);
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

  return (
    <BaseWidget title={t('Who to follow')}>
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>Loading recommendations...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={[styles.errorText, { color: theme.colors.error }]}>Error: {error}</Text>
        </View>
      ) : recommendations?.length ? (
        <View>
          {recommendations.slice(0, 5).map((data: any, index: number) => (
            <FollowRowComponent key={data.id || index} profileData={data} />
          ))}
          <TouchableOpacity onPress={() => router.push('/explore')} style={styles.showMoreBtn} activeOpacity={0.7}>
            <Text style={[styles.showMoreText, { color: theme.colors.primary }]}>{t('Show more')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.loadingContainer}>
          <Text style={{ color: theme.colors.textSecondary }}>No recommendations available</Text>
        </View>
      )}
    </BaseWidget>
  );
}

function FollowRowComponent({ profileData }: { profileData: any }) {
  const router = useRouter();
  const { oxyServices } = useOxy();
  const theme = useTheme();
  const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string; size?: 'small' | 'medium' | 'large' }>;
  if (!profileData?.id) return null;

  const displayName = profileData.name?.first
    ? `${profileData.name.first} ${profileData.name.last || ''}`.trim()
    : profileData.username || 'Unknown User';

  const avatarUri = profileData?.avatar
    ? oxyServices.getFileDownloadUrl(profileData.avatar as string, 'thumb')
    : undefined;
  const username = profileData.username || profileData.id;

  return (
    <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
      <View style={styles.rowLeft}>
        <Avatar source={avatarUri} />
        <View style={styles.rowTextWrap}>
          <Text style={[styles.rowTitle, { color: theme.colors.text }]} onPress={() => router.push(`/@${username}`)}>{displayName}</Text>
          <Text style={[styles.rowSub, { color: theme.colors.textSecondary }]} onPress={() => router.push(`/@${username}`)}>@{username}</Text>
          {profileData.bio && (
            <Text style={[styles.rowBio, { color: theme.colors.textSecondary }]} numberOfLines={2}>{profileData.bio}</Text>
          )}
        </View>
      </View>
      <FollowButton userId={profileData.id} size="small" />
    </View>
  );
}

const styles = StyleSheet.create({
  // Header handled by BaseWidget
  loadingContainer: {
    paddingVertical: 12,
    alignItems: 'center',
    gap: 6,
  },
  loadingText: {},
  errorContainer: {
    paddingVertical: 12,
  },
  errorText: {},
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 0.01,
    paddingVertical: 10,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowTextWrap: { marginRight: 'auto', marginLeft: 13, flex: 1 },
  rowTitle: { fontWeight: 'bold', fontSize: 15 },
  rowSub: { paddingTop: 4 },
  rowBio: { paddingTop: 4, fontSize: 13 },
  showMoreBtn: {
    paddingTop: 10,
  },
  showMoreText: {
    fontSize: 15,
  },
});
