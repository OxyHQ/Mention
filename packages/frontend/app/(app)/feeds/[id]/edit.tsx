import React from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';

import { useSafeBack } from '@/hooks/useSafeBack';
import { customFeedsService } from '@/services/customFeedsService';
import { FeedBuilder } from '@/components/feeds/FeedBuilder';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * Edit an existing custom feed (owner only). Loads the feed, re-verifies
 * ownership (the detail-screen Edit entry point already gates on it), and hands
 * the stored definition to the shared {@link FeedBuilder}.
 */
export default function EditFeedScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const feedId = String(id);
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { user, isAuthResolved, canUsePrivateApi } = useAuth();

  const { data: feed, isLoading } = useQuery({
    queryKey: viewerQueryKeys.customFeed(user?.id, feedId),
    enabled: Boolean(feedId) && canUsePrivateApi,
    queryFn: () => customFeedsService.get(feedId),
  });

  const notReady = !isAuthResolved || (canUsePrivateApi && (isLoading || !feed));
  const isOwner = Boolean(user?.id && feed?.ownerOxyUserId === user.id);

  if (notReady) {
    return (
      <View className="flex-1">
        <PageHeader
          title={t('feeds.builder.editTitle')}
          onBack={() => safeBack()}
          backLabel={t('common.back', { defaultValue: 'Back' })}
        />
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  if (!feed || !isOwner) {
    return (
      <View className="flex-1">
        <PageHeader
          title={t('feeds.builder.editTitle')}
          onBack={() => safeBack()}
          backLabel={t('common.back', { defaultValue: 'Back' })}
        />
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-base text-center text-muted-foreground">
            {t('feeds.builder.notAllowed', { defaultValue: "You can't edit this feed." })}
          </Text>
        </View>
      </View>
    );
  }

  return <FeedBuilder feedId={feedId} initialFeed={feed} />;
}
