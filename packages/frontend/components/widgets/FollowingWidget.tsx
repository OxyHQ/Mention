import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { FollowButton, Models, useOxy } from '@oxyhq/services/full';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import { BaseWidget } from './BaseWidget';

export function FollowingWidget() {
  const { user, oxyServices } = useOxy();
  const { t } = useTranslation();
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState<Models.User[] | null>(null);

  useEffect(() => {
    const fetchFollowing = async () => {
      if (!user?.id) return;
      try {
        setLoading(true);
        setError(null);
        const res: any = await oxyServices.getUserFollowing(user.id);
        const list = Array.isArray(res?.following) ? res.following : Array.isArray(res) ? res : [];
        setFollowing(list.slice(0, 5));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load following');
        console.error('Error fetching following:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchFollowing();
  }, [user?.id, oxyServices]);

  if (!user?.id) return null;

  return (
    <BaseWidget title={t('Following')}>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={colors.primaryColor} />
          <Text style={styles.loadingText}>Loading following...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Error: {error}</Text>
        </View>
      ) : (following && following.length > 0) ? (
        <View>
          {following.map((u, idx) => (
            <View key={(u as any).id || idx} style={styles.row}>
              <View style={styles.rowLeft}>
                <Avatar source={(u as any)?.avatar?.url || (u as any)?.avatar} />
                <View style={styles.rowTextWrap}>
                  <Text style={styles.rowTitle} onPress={() => router.push(`/@${u.username || (u as any).id}`)}>
                    {u.name?.first ? `${u.name.first} ${u.name.last || ''}`.trim() : u.username}
                  </Text>
                  <Text style={styles.rowSub} onPress={() => router.push(`/@${u.username || (u as any).id}`)}>@{u.username || (u as any).id}</Text>
                </View>
              </View>
              <FollowButton userId={(u as any).id || (u as any)._id || (u as any).userID} size="small" />
            </View>
          ))}
          <TouchableOpacity onPress={() => router.push(`/@${user.username || user.id}/following`)} style={{ paddingTop: 10 }}>
            <Text style={{ fontSize: 15, color: colors.primaryColor }}>{t('See all')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.loadingContainer}>
          <Text>No following yet</Text>
        </View>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  // Header handled by BaseWidget
  loadingContainer: { paddingVertical: 12, alignItems: 'center', gap: 6 },
  loadingText: { color: colors.COLOR_BLACK_LIGHT_4 },
  errorContainer: { paddingVertical: 12 },
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
});
