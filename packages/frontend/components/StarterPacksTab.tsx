import React, { useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, Text } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from '@/components/ThemedText';
import { StarterPackCard, type StarterPackCardData } from '@/components/StarterPackCard';
import { starterPacksService } from '@/services/starterPacksService';
import { EmptyState } from '@/components/common/EmptyState';
import LegendList from '@/components/LegendList';

export function StarterPacksTab() {
  const router = useRouter();
  const theme = useTheme();
  const [loading, setLoading] = useState(true);
  const [packs, setPacks] = useState<any[]>([]);

  const fetchPacks = useCallback(async () => {
    try {
      setLoading(true);
      const res = await starterPacksService.list();
      setPacks(res.items || []);
    } catch (e) {
      console.warn('load starter packs failed', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPacks();
  }, [fetchPacks]);

  if (loading) {
    return <Loading />;
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
      memberCount: (item.memberOxyUserIds || []).length,
      useCount: item.useCount || 0,
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
          style={[styles.createButton, { backgroundColor: theme.colors.primary }]}
          onPress={() => router.push('/starter-packs/create')}
        >
          <Text style={[styles.createButtonText, { color: theme.colors.card }]}>
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
