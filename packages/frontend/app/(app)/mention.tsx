import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTranslation } from 'react-i18next';
import { Redirect, useLocalSearchParams } from '@/lib/navigation/router';
import { ProfileUnavailable } from '@/components/Profile/ProfileUnavailable';
import { SEO } from '@/components/SEO';
import { useSafeBack } from '@/hooks/useSafeBack';
import { resolveMention } from '@/utils/resolveMention';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';

/** Imported mentions without an ID resolve on demand, never outside Mention. */
export default function MentionRoute() {
  const { uri } = useLocalSearchParams<{ uri?: string }>();
  const source = typeof uri === 'string' ? uri : '';
  const valid = /^https?:\/\//i.test(source);
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const query = useQuery({
    queryKey: publicQueryKeys.mentionResolve(source),
    queryFn: () => resolveMention(source),
    enabled: valid,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const handle = query.data?.oxyUserId
    ? getNormalizedUserHandle({ username: query.data.handle })
    : null;

  if (handle) return <Redirect href={`/@${handle}`} />;

  return (
    <View className="flex-1">
      <SEO title={t('Profile', { defaultValue: 'Profile' })} robots="noindex,follow" />
      <PageHeader
        title={t('Profile', { defaultValue: 'Profile' })}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />
      {valid && query.isPending ? (
        <FeedSkeleton />
      ) : (
        <ProfileUnavailable
          notFound={!valid || (!query.isError && !handle)}
          onRetry={async () => {
            await query.refetch();
          }}
        />
      )}
    </View>
  );
}
