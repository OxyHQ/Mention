import React, { useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { StarterPackCard, StarterPackCardSkeleton, type StarterPackCardData } from '@/components/StarterPackCard';
import { starterPacksService, type StarterPackSummary } from '@/services/starterPacksService';
import { EmptyState } from '@/components/common/EmptyState';
import { VirtualList } from '@oxyhq/bloom/list';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';

export function StarterPacksTab() {
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [packs, setPacks] = useState<StarterPackSummary[]>([]);

  const fetchPacks = useCallback(async () => {
    try {
      setLoading(true);
      const res = await starterPacksService.list();
      setPacks(res.items || []);
    } catch (e) {
      logger.warn('load starter packs failed', { error: e });
    } finally {
      setLoading(false);
    }
    // `user?.id` is in the deps so the callback identity changes when the auth
    // session resolves on cold boot. Without it the effect below fires once
    // while the SSO restore is still pending — the starter-packs read 401s, the
    // error is swallowed, and the tab is stuck on the empty state forever.
  }, [user?.id]);

  useEffect(() => {
    fetchPacks();
  }, [fetchPacks]);

  if (loading) {
    return (
      <View style={styles.list}>
        {Array.from({ length: 3 }).map((_, i) => (
          <View key={i} style={styles.cardWrapper}>
            <StarterPackCardSkeleton />
          </View>
        ))}
      </View>
    );
  }

  if (packs.length === 0) {
    return (
      <EmptyState
        title="No starter packs yet"
        subtitle="Be the first to create a starter pack and help others discover great accounts"
        icon={{ name: 'rocket-outline', size: 48 }}
        action={{
          label: t('starterPacks.create'),
          onPress: () => router.push('/starter-packs/create'),
        }}
        containerStyle={styles.emptyState}
      />
    );
  }

  const renderItem = ({ item }: { item: StarterPackSummary }) => {
    const memberCount = item.memberCount ?? (item.memberOxyUserIds || []).length;
    const cardData: StarterPackCardData = {
      id: String(item._id || item.id),
      name: item.name || 'Untitled Pack',
      description: item.description,
      creator: item.creator,
      memberCount,
      useCount: item.useCount || 0,
      memberAvatars: item.memberAvatars ?? [],
      totalMembers: memberCount,
    };

    return (
      <View style={styles.cardWrapper}>
        <StarterPackCard
          pack={cardData}
          onPress={() => router.push(`/starter-packs/${item._id || item.id}`)}
        />
      </View>
    );
  };

  return (
    <VirtualList
      data={packs}
      renderItem={renderItem}
      keyExtractor={(item: StarterPackSummary) => String(item._id || item.id)}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <TouchableOpacity
          className="bg-primary"
          style={styles.createButton}
          onPress={() => router.push('/starter-packs/create')}
        >
          <Text className="text-primary-foreground" style={styles.createButtonText}>
            {t('starterPacks.create')}
          </Text>
        </TouchableOpacity>
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 },
  cardWrapper: { marginBottom: 8 },
  emptyState: { paddingVertical: 36, paddingHorizontal: 20 },
  createButton: { paddingVertical: 12, borderRadius: 20, alignItems: 'center', marginBottom: 16 },
  createButtonText: { fontWeight: '700', fontSize: 15 },
});
