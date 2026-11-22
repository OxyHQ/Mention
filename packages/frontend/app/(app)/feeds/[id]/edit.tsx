import { useScreenBack } from '@oxy.so/bloom/screen';
import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';

import { customFeedsService } from '@/services/customFeedsService';
import FeedBuilder from '@/components/feeds/LazyFeedBuilder';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

import { Embed, Header, RawText, VStack, toElement } from '@oxy.so/bloom-language';

/**
 * Edit an existing custom feed (owner only). Loads the feed, re-verifies
 * ownership (the detail-screen Edit entry point already gates on it), and hands
 * the stored definition to the shared {@link FeedBuilder}.
 */
function EditFeedScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const feedId = String(id);
  const { t } = useTranslation();
  const back = useScreenBack();
  const { user, isAuthResolved, canUsePrivateApi } = useAuth();

  const { data: feed, isLoading } = useQuery({
    queryKey: viewerQueryKeys.customFeed(user?.id, feedId),
    enabled: Boolean(feedId) && canUsePrivateApi,
    queryFn: () => customFeedsService.get(feedId),
  });

  const notReady = !isAuthResolved || (canUsePrivateApi && (isLoading || !feed));
  const isOwner = Boolean(user?.id && feed?.ownerOxyUserId === user.id);

  if (notReady) {
    return toElement(
      VStack(
        Header(t('feeds.builder.editTitle'))
          .onBack(back)
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
        Embed(<FormSkeleton />),
      ).flex('1'),
    );
  }

  if (!feed || !isOwner) {
    return toElement(
      VStack(
        Header(t('feeds.builder.editTitle'))
          .onBack(back)
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
        VStack(
          RawText(t('feeds.builder.notAllowed', { defaultValue: "You can't edit this feed." }))
            .font('16')
            .leading('normal')
            .textAlign('center')
            .foreground('muted'),
        )
          .padding('horizontal', '3xl')
          .flex('1')
          .align('center')
          .justify('center'),
      ).flex('1'),
    );
  }

  return <FeedBuilder feedId={feedId} initialFeed={feed} />;
}

export default function AvailableEditFeedScreen() {
  return (
    <SupervisedFeatureGate>
      <EditFeedScreen />
    </SupervisedFeatureGate>
  );
}
