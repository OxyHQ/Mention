import { useEffect, useState, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  StarterPackCard,
  StarterPackCardSkeleton,
  starterPackCardData,
} from '@/components/StarterPackCard';
import { starterPacksService, type StarterPackSummary } from '@/services/starterPacksService';
import { EmptyState } from '@/components/common/EmptyState';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';
import { VirtualList } from '@oxy.so/bloom-language/list';

export function StarterPacksTab() {
  const router = useRouter();
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();
  const [loading, setLoading] = useState(true);
  const [packs, setPacks] = useState<StarterPackSummary[]>([]);

  const fetchPacks = useCallback(async () => {
    if (!user?.id) {
      setPacks([]);
      setLoading(false);
      return;
    }
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
    return toElement(
      VStack(
        Embed(
          Array.from({ length: 3 }).map((_, i) =>
            toElement(VStack(Embed(<StarterPackCardSkeleton />)).margin('bottom', 'sm'), i),
          ),
        ),
      )
        .padding('left', 'lg')
        .padding('right', 'lg')
        .padding('top', 'sm')
        .padding('bottom', '3xl'),
    );
  }

  if (packs.length === 0) {
    return (
      <EmptyState
        title="No starter packs yet"
        subtitle="Be the first to create a starter pack and help others discover great accounts"
        sticker="starterPacks"
        // Creating one needs a session; signed out the empty state stays
        // informational rather than offering a form that cannot submit.
        action={
          canUsePrivateApi
            ? {
                label: t('starterPacks.create'),
                onPress: () => router.push('/starter-packs/create'),
              }
            : undefined
        }
        containerStyle={styles.emptyState}
      />
    );
  }

  const renderItem = ({ item }: { item: StarterPackSummary }) => {
    const cardData = starterPackCardData(item);

    return toElement(
      VStack(
        Embed(
          <StarterPackCard
            pack={cardData}
            onPress={() => router.push(`/starter-packs/${item._id || item.id}`)}
          />,
        ),
      ).margin('bottom', 'sm'),
    );
  };

  return toElement(
    VirtualList(packs, renderItem)
      .screen()
      .itemKey((item: StarterPackSummary) => String(item._id || item.id))
      .contentMargins('left', 'lg')
      .contentMargins('right', 'lg')
      .contentMargins('top', 'sm')
      .contentMargins('bottom', '3xl')
      .headerContent(
        VStack(RawText(t('starterPacks.create')).foreground('onPrimary').weight('bold').font('md'))
          .padding('vertical', 'md')
          .background('primary')
          .corner('xl')
          .align('center')
          .margin('bottom', 'lg')
          .onPress(() => router.push('/starter-packs/create'))
          .pressFade(),
      ),
  );
}

const styles = StyleSheet.create({
  list: { paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 32 },
  cardWrapper: { marginBottom: 8 },
  emptyState: { paddingVertical: 36, paddingHorizontal: 20 },
});
