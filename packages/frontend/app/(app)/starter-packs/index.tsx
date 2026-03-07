import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { starterPacksService } from '@/services/starterPacksService';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import SEO from '@/components/SEO';
import { StarterPackCard, type StarterPackCardData } from '@/components/StarterPackCard';
import { EmptyState } from '@/components/common/EmptyState';

export default function StarterPacksScreen() {
  const [myPacks, setMyPacks] = useState<any[]>([]);
  const theme = useTheme();
  const { t } = useTranslation();

  useEffect(() => {
    (async () => {
      try {
        const res = await starterPacksService.list({ mine: true });
        setMyPacks(res.items || []);
      } catch (e) {
        console.warn('load starter packs failed', e);
      }
    })();
  }, []);

  return (
    <>
      <SEO
        title="Starter Packs"
        description="Curated collections of accounts to follow"
      />
      <ThemedView style={{ flex: 1 }}>
        <Header options={{
          title: 'Starter Packs',
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
          rightComponents: [
            <TouchableOpacity key="create" onPress={() => router.push('/starter-packs/create')} style={[styles.newPill, { backgroundColor: theme.colors.primary }]}>
              <Text style={[styles.newPillText, { color: theme.colors.card }]}>New</Text>
            </TouchableOpacity>
          ]
        }}
        hideBottomBorder={true}
        disableSticky={true}
        />

        <ScrollView showsVerticalScrollIndicator={false} style={styles.content}>
          {myPacks.length === 0 ? (
            <EmptyState
              title="No starter packs yet"
              subtitle="Create a starter pack to help others discover great accounts"
              icon={{
                name: 'rocket-outline',
                size: 48,
              }}
              action={{
                label: 'Create Starter Pack',
                onPress: () => router.push('/starter-packs/create'),
              }}
              containerStyle={styles.emptyState}
            />
          ) : (
            <View style={styles.packsContainer}>
              {myPacks.map((p: any) => {
                const cardData: StarterPackCardData = {
                  id: String(p._id || p.id),
                  name: p.name || 'Untitled Pack',
                  description: p.description,
                  memberCount: (p.memberOxyUserIds || []).length,
                  useCount: p.useCount || 0,
                };

                return (
                  <View key={String(p._id || p.id)} style={styles.cardWrapper}>
                    <StarterPackCard
                      pack={cardData}
                      onPress={() => router.push(`/starter-packs/${p._id || p.id}`)}
                    />
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 12, paddingTop: 10 },
  packsContainer: { paddingHorizontal: 4 },
  cardWrapper: { paddingHorizontal: 12, marginBottom: 8 },
  newPill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  newPillText: { fontWeight: '700' },
  emptyState: { paddingVertical: 36, paddingHorizontal: 20 },
});
