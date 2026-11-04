import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Title } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import { FollowButton } from '@/components/FollowButton';
import {
  StarterPackCard,
  StarterPackCardSkeleton,
  starterPackCardData,
  starterPackId,
} from '@/components/StarterPackCard';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useRouter } from '@/lib/navigation/router';
import { starterPacksService } from '@/services/starterPacksService';

/** A first-run screen offers a few packs, not the catalogue. */
const WELCOME_STARTER_PACKS = 3;

/**
 * Starter packs above the people suggestions on `/welcome`: one tap follows a
 * whole pack, which is the quickest way out of an empty Following feed.
 *
 * Same query as the feed's starter-pack interstitial (`excludeUsed`, the same
 * key), so the two never disagree about which packs a viewer has left.
 */
export function WelcomeStarterPacks() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, canUsePrivateApi } = useAuth();

  const query = useQuery({
    queryKey: viewerQueryKeys.feedInterstitial(user?.id, 'suggested-starter-packs'),
    queryFn: () => starterPacksService.list({ excludeUsed: true }),
    enabled: canUsePrivateApi,
  });

  // Following is the FollowButton's job; recording that the pack was USED (which
  // ranks packs for everyone else) is ours, and best-effort.
  const recordUse = useMutation({
    mutationFn: (packId: string) => starterPacksService.use(packId),
    onError: (error, packId) => {
      logger.warn('Welcome: recording starter-pack usage failed', { error, packId });
    },
  });

  const packs = (query.data?.items ?? []).slice(0, WELCOME_STARTER_PACKS);
  if (!query.isPending && packs.length === 0) return null;

  return (
    <View className="gap-3 px-4 pb-6">
      <Title variant="headline-semibold">{t('welcome.people.packsTitle')}</Title>
      {query.isPending ? (
        <StarterPackCardSkeleton />
      ) : (
        packs.map((pack) => {
          const id = starterPackId(pack);
          return (
            <View key={id} className="gap-2">
              <StarterPackCard
                pack={starterPackCardData(pack)}
                onPress={() => router.push(`/starter-packs/${id}`)}
              />
              <FollowButton
                userIds={pack.memberOxyUserIds ?? []}
                size="sm"
                followAllLabel={t('welcome.people.followAll')}
                followedAllLabel={t('welcome.people.followingAll')}
                onBulkFollow={() => recordUse.mutate(id)}
              />
            </View>
          );
        })
      )}
      <Title variant="headline-semibold" className="pt-4">
        {t('welcome.people.suggestionsTitle')}
      </Title>
    </View>
  );
}
