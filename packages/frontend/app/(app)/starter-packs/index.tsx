import React, { useEffect, useState } from 'react';
import { View, TouchableOpacity, Text, ScrollView } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { starterPacksService } from '@/services/starterPacksService';
import { router } from 'expo-router';
import SEO from '@/components/SEO';
import { StarterPackCard, StarterPackCardSkeleton, type StarterPackCardData } from '@/components/StarterPackCard';
import { EmptyState } from '@/components/common/EmptyState';

export default function StarterPacksScreen() {
  const [myPacks, setMyPacks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await starterPacksService.list({ mine: true });
        setMyPacks(res.items || []);
      } catch (e) {
        console.warn('load starter packs failed', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <>
      <SEO
        title="Starter Packs"
        description="Curated collections of accounts to follow"
      />
      <ThemedView className="flex-1">
        <Header options={{
          title: 'Starter Packs',
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: [
            <TouchableOpacity key="create" onPress={() => router.push('/starter-packs/create')} className="px-3.5 py-1.5 rounded-full items-center justify-center bg-primary">
              <Text className="font-bold text-primary-foreground">New</Text>
            </TouchableOpacity>
          ]
        }}
        hideBottomBorder={true}
        disableSticky={true}
        />

        <ScrollView showsVerticalScrollIndicator={false} className="px-3 pt-2.5">
          {loading ? (
            <View className="px-1 gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <View key={i} className="px-3">
                  <StarterPackCardSkeleton />
                </View>
              ))}
            </View>
          ) : myPacks.length === 0 ? (
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
              containerStyle={{ paddingVertical: 36, paddingHorizontal: 20 }}
            />
          ) : (
            <View className="px-1">
              {myPacks.map((p: any) => {
                const cardData: StarterPackCardData = {
                  id: String(p._id || p.id),
                  name: p.name || 'Untitled Pack',
                  description: p.description,
                  creator: p.creator || p.owner,
                  memberCount: (p.memberOxyUserIds || []).length,
                  useCount: p.useCount || 0,
                  memberAvatars: p.memberAvatars || [],
                  totalMembers: (p.memberOxyUserIds || []).length,
                };

                return (
                  <View key={String(p._id || p.id)} className="px-3 mb-2">
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
