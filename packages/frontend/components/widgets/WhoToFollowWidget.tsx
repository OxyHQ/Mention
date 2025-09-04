import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Link, useRouter } from 'expo-router';
import { FollowButton, Models, useOxy } from '@oxyhq/services/full';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import { BaseWidget } from './BaseWidget';

export function WhoToFollowWidget() {
  const { oxyServices } = useOxy();
  const { t } = useTranslation();
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Models.User[] | null>(null);

  useEffect(() => {
    const fetchRecommendations = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await oxyServices.getProfileRecommendations();
        setRecommendations(response || []);
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
          <ActivityIndicator size="small" color={colors.primaryColor} />
          <Text style={styles.loadingText}>Loading recommendations...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Error: {error}</Text>
        </View>
      ) : recommendations?.length ? (
        <View>
          {recommendations.slice(0, 5).map((data, index) => (
            <FollowRowComponent key={data.id || index} profileData={data} />
          ))}
          <TouchableOpacity onPress={() => router.push('/explore')} style={styles.showMoreBtn} activeOpacity={0.7}>
            <Text style={styles.showMoreText}>{t('Show more')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.loadingContainer}>
          <Text>No recommendations available</Text>
        </View>
      )}
    </BaseWidget>
  );
}

function FollowRowComponent({ profileData }: { profileData: Models.User }) {
  const { oxyServices } = useOxy();
  if (!profileData?.id) return null;

  const displayName = profileData.name?.first
    ? `${profileData.name.first} ${profileData.name.last || ''}`.trim()
    : profileData.username || 'Unknown User';

  const avatarUri = profileData?.avatar
    ? oxyServices.getFileDownloadUrl(profileData.avatar as string, 'thumb')
    : undefined;
  const username = profileData.username || profileData.id;

  return (
    <Link href={`/@${username}`} asChild>
      <View style={styles.row}>
        <View style={styles.rowLeft}>
          <Avatar source={avatarUri} />
          <View style={styles.rowTextWrap}>
            <Text style={styles.rowTitle}>{displayName}</Text>
            <Text style={styles.rowSub}>@{username}</Text>
            {profileData.bio && (
              <Text style={styles.rowBio} numberOfLines={2}>{profileData.bio}</Text>
            )}
          </View>
        </View>
        <FollowButton userId={profileData.id} size="small" />
      </View>
    </Link>
  );
}

const styles = StyleSheet.create({
  // Header handled by BaseWidget
  loadingContainer: {
    paddingVertical: 12,
    alignItems: 'center',
    gap: 6,
  },
  loadingText: {
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  errorContainer: {
    paddingVertical: 12,
  },
  errorText: { color: 'red' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 0.01,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    paddingVertical: 10,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowTextWrap: { marginRight: 'auto', marginLeft: 13, flex: 1 },
  rowTitle: { fontWeight: 'bold', fontSize: 15, color: colors.COLOR_BLACK_LIGHT_1 },
  rowSub: { color: colors.COLOR_BLACK_LIGHT_4, paddingTop: 4 },
  rowBio: { color: colors.COLOR_BLACK_LIGHT_4, paddingTop: 4, fontSize: 13 },
  showMoreBtn: {
    paddingTop: 10,
  },
  showMoreText: {
    fontSize: 15,
    color: colors.primaryColor,
  },
});
