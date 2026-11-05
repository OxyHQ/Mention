import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { ResponsiveGrid } from '@oxy.so/bloom/grid';
import { Button } from '@oxy.so/bloom/button';
import { Muted } from '@oxy.so/bloom/typography';
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

  // The catalogue is public, so it loads for a visitor too; only following a
  // pack needs a session. Gating the query on the session left a visitor with a
  // skeleton that never resolved.
  const query = useQuery({
    queryKey: viewerQueryKeys.feedInterstitial(user?.id, 'suggested-starter-packs'),
    queryFn: () => starterPacksService.list({ excludeUsed: true }),
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
  // A failed load is shown as one, with a retry, and never as a missing section.
  if (!query.isPending && !query.isError && packs.length === 0) return null;

  // One CardBody per pack: each body carries its own vertical padding, so the
  // packs stack with Bloom's spacing between them and align with the header.
  return (
    <>
      <CardHeader>
        <CardTitle>{t('welcome.people.packsTitle')}</CardTitle>
        <CardDescription>{t('welcome.people.packsDescription')}</CardDescription>
      </CardHeader>
      <CardBody>
        {query.isPending ? (
          <StarterPackCardSkeleton />
        ) : query.isError ? (
          <>
            <Muted>{t('welcome.people.loadError')}</Muted>
            <Button
              size="sm"
              appearance="subtle"
              tone="neutral"
              onPress={() => void query.refetch()}
            >
              {t('common.retry')}
            </Button>
          </>
        ) : (
          <ResponsiveGrid minItemWidth={260} maxColumns={2}>
            {packs.map((pack) => {
              const id = starterPackId(pack);
              return (
                <StarterPackCard
                  key={id}
                  pack={starterPackCardData(pack)}
                  onPress={() => router.push(`/starter-packs/${id}`)}
                  footer={
                    canUsePrivateApi ? (
                      <FollowButton
                        userIds={pack.memberOxyUserIds ?? []}
                        size="sm"
                        followAllLabel={t('welcome.people.followAll')}
                        followedAllLabel={t('welcome.people.followingAll')}
                        onBulkFollow={() => recordUse.mutate(id)}
                      />
                    ) : (
                      <Muted>{t('welcome.people.signInToFollow')}</Muted>
                    )
                  }
                />
              );
            })}
          </ResponsiveGrid>
        )}
      </CardBody>
      <CardHeader>
        <CardTitle>{t('welcome.people.suggestionsTitle')}</CardTitle>
        <CardDescription>{t('welcome.people.suggestionsDescription')}</CardDescription>
      </CardHeader>
    </>
  );
}
