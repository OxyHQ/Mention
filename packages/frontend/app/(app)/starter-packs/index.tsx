import React, { useCallback, useState } from 'react';
import { View, ScrollView, Platform } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useAuth } from '@oxy.so/services/ui/client';
import { starterPacksService, type StarterPackSummary } from '@/services/starterPacksService';
import { router, useFocusEffect } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { SEO } from '@/components/SEO';
import { StarterPackCard, StarterPackCardSkeleton, type StarterPackCardData } from '@/components/StarterPackCard';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import { EmptyState } from '@/components/common/EmptyState';
import { StarterPackIcon } from '@/assets/icons/starter-pack-icon';
import { SignInRequired } from '@/components/common/SignInRequired';

const IS_WEB = Platform.OS === 'web';

export default function StarterPacksScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { canUsePrivateApi } = useAuth();
  const [myPacks, setMyPacks] = useState<StarterPackSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // The viewer's own packs are a private read; signed out the screen shows
  // the sign-in prompt instead, so there is nothing to fetch. `canUsePrivateApi`
  // is a dependency so the focus effect re-runs once the session resolves.
  const load = useCallback(async () => {
    if (!canUsePrivateApi) return;
    try {
      const res = await starterPacksService.list({ mine: true });
      setMyPacks(res.items || []);
    } catch (e) {
      logger.warn('load starter packs failed', { error: e });
    } finally {
      setLoading(false);
    }
  }, [canUsePrivateApi]);

  // Refresh on every focus so returning from create/edit/delete shows fresh
  // data — the linked client is uncached (core 3.9.0), so each call hits the
  // network. Mirrors the detail screen's freshness pattern.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Directory body — identical on both platforms; only the scroll host differs.
  const content = loading ? (
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
      customIcon={<StarterPackIcon size={48} className="text-muted-foreground" />}
      action={{
        label: t('starterPacks.create'),
        onPress: () => router.push('/starter-packs/create'),
      }}
      containerStyle={{ paddingVertical: 36, paddingHorizontal: 20 }}
    />
  ) : (
    <View className="px-1">
      {myPacks.map((p: StarterPackSummary) => {
        const memberCount = p.memberCount ?? (p.memberOxyUserIds || []).length;
        const cardData: StarterPackCardData = {
          id: String(p._id || p.id),
          name: p.name || 'Untitled Pack',
          description: p.description,
          creator: p.creator,
          memberCount,
          useCount: p.useCount || 0,
          memberAvatars: p.memberAvatars ?? [],
          totalMembers: memberCount,
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
  );

  return (
    <>
      <SEO
        title="Starter Packs"
        description="Curated collections of accounts to follow"
      />
      <View className="flex-1">
        <PageHeader
          title={t('starterPacks.title')}
          onBack={() => safeBack()}
          backLabel={t('common.back', { defaultValue: 'Back' })}
          actions={
            canUsePrivateApi ? (
              <Button size="small" onPress={() => router.push('/starter-packs/create')}>
                New
              </Button>
            ) : undefined
          }
        />

        <SignInRequired
          label={t('starterPacks.signInRequired', { defaultValue: 'Sign in to use starter packs' })}
          description={t('starterPacks.signInRequiredDesc', {
            defaultValue: 'A starter pack is a set of accounts you recommend following together.',
          })}
        >
          {/* WEB: the document (body) is the scroller — the shell owns scroll, so
              the directory renders in normal flow. A ScrollView here would nest a
              second scroll container inside the ContentPanel and break the sticky
              side rails, window scroll-restoration and bottom-bar auto-hide.
              NATIVE: a ScrollView is the correct screen scroller. */}
          {IS_WEB ? (
            <View className="px-3 pt-2.5">{content}</View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} className="px-3 pt-2.5">
              {content}
            </ScrollView>
          )}
        </SignInRequired>
      </View>
    </>
  );
}
