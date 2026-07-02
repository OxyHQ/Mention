import React from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { customFeedsService } from '@/services/customFeedsService';
import { FeedBuilder } from '@/components/feeds/FeedBuilder';

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
    queryKey: ['customFeed', feedId, user?.id],
    enabled: Boolean(feedId) && canUsePrivateApi,
    queryFn: () => customFeedsService.get(feedId),
  });

  const notReady = !isAuthResolved || (canUsePrivateApi && (isLoading || !feed));
  const isOwner = Boolean(user?.id && feed?.ownerOxyUserId === user.id);

  if (notReady) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('feeds.builder.editTitle'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  if (!feed || !isOwner) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('feeds.builder.editTitle'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-base text-center text-muted-foreground">
            {t('feeds.builder.notAllowed', { defaultValue: "You can't edit this feed." })}
          </Text>
        </View>
      </ThemedView>
    );
  }

  return <FeedBuilder feedId={feedId} initialFeed={feed} />;
}
