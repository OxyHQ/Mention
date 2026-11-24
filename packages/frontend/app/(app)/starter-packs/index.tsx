import { useCallback, useState } from 'react';
import { useAuth } from '@oxy.so/services/ui/client';
import { starterPacksService, type StarterPackSummary } from '@/services/starterPacksService';
import { useRouter, useFocusEffect } from '@/lib/navigation/router';
import { SEO } from '@/components/SEO';
import {
  StarterPackCard,
  StarterPackCardSkeleton,
  starterPackCardData,
} from '@/components/StarterPackCard';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import { EmptyState } from '@/components/common/EmptyState';
import { SignInRequired } from '@/components/common/SignInRequired';

import {
  Button as LButton,
  Embed,
  Header,
  ScrollView,
  Text,
  VStack,
  toElement,
  Group,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

export default screen(function StarterPacksScreen() {
  const router = useRouter();
  const { t } = useTranslation();
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
    }, [load]),
  );

  // Directory body — identical on both platforms; only the scroll host differs.
  const content = loading ? (
    toElement(
      VStack(
        Embed(
          Array.from({ length: 3 }).map((_, i) =>
            toElement(VStack(Embed(<StarterPackCardSkeleton />)).padding('horizontal', 'md'), i),
          ),
        ),
      )
        .padding('horizontal', 'xs')
        .spacing('sm'),
    )
  ) : myPacks.length === 0 ? (
    <EmptyState
      title="No starter packs yet"
      subtitle="Create a starter pack to help others discover great accounts"
      sticker="starterPacks"
      action={{
        label: t('starterPacks.create'),
        onPress: () => router.push('/starter-packs/create'),
      }}
      containerStyle={{ paddingVertical: 36, paddingHorizontal: 20 }}
    />
  ) : (
    toElement(
      VStack(
        Embed(
          myPacks.map((p: StarterPackSummary) => {
            const cardData = starterPackCardData(p);

            return toElement(
              VStack(
                Embed(
                  <StarterPackCard
                    pack={cardData}
                    onPress={() => router.push(`/starter-packs/${p._id || p.id}`)}
                  />,
                ),
              )
                .padding('horizontal', 'md')
                .margin('bottom', 'sm'),
              String(p._id || p.id),
            );
          }),
        ),
      ).padding('horizontal', 'xs'),
    )
  );

  // The SEO tags draw nothing in place (the document's head on the web).
  return Group(
    Embed(
      <SEO
        title="Starter Packs"
        description="Curated collections of accounts to follow"
        robots="index,follow"
      />,
    ),
    Embed(
      <SignInRequired
        label={t('starterPacks.signInRequired', { defaultValue: 'Sign in to use starter packs' })}
        description={t('starterPacks.signInRequiredDesc', {
          defaultValue: 'A starter pack is a set of accounts you recommend following together.',
        })}
      >
        {toElement(
          ScrollView(Embed(content)).contentView((v) =>
            v.padding('horizontal', 'md').padding('top', '10'),
          ),
        )}
      </SignInRequired>,
    ),
  ).header(
    Header(t('starterPacks.title'))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .toolbar(
        Embed(
          canUsePrivateApi
            ? toElement(LButton(Text('New')).onPress(() => router.push('/starter-packs/create')))
            : undefined,
        ),
      )
      .inPage(),
  );
});
