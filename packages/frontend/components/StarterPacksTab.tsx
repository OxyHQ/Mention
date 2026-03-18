import React, { useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { StarterPackCard, StarterPackCardSkeleton, type StarterPackCardData } from '@/components/StarterPackCard';
import { starterPacksService } from '@/services/starterPacksService';
import { EmptyState } from '@/components/common/EmptyState';
import LegendList from '@/components/LegendList';
import { logger } from '@/lib/logger';

export function StarterPacksTab() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [packs, setPacks] = useState<any[]>([]);

  const fetchPacks = useCallback(async () => {
    try {
      setLoading(true);
      const res = await starterPacksService.list();
      setPacks(res.items || []);
    } catch (e) {
      logger.warn('load starter packs failed');
    } finally {
      setLoading(false);
    }
  }, []);

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
          label: 'Create Starter Pack',
          onPress: () => router.push('/starter-packs/create'),
        }}
        containerStyle={styles.emptyState}
      />
    );
  }

  const renderItem = ({ item }: { item: any }) => {
    const cardData: StarterPackCardData = {
      id: String(item._id || item.id),
      name: item.name || 'Untitled Pack',
      description: item.description,
      creator: item.creator || item.owner,
      memberCount: (item.memberOxyUserIds || []).length,
      useCount: item.useCount || 0,
      memberAvatars: item.memberAvatars || [],
      totalMembers: (item.memberOxyUserIds || []).length,
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
    <LegendList
      data={packs}
      renderItem={renderItem}
      keyExtractor={(item: any) => String(item._id || item.id)}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <TouchableOpacity
          className="bg-primary"
          style={styles.createButton}
          onPress={() => router.push('/starter-packs/create')}
        >
          <Text className="text-primary-foreground" style={styles.createButtonText}>
            Create Starter Pack
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
