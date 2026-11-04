import { useCallback } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { ChatListItemSkeleton } from '@oxy.so/bloom/chat-list';
import { VirtualList } from '@oxy.so/bloom/list';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import type { PrivateMentionConversation } from '@mention/shared-types';
import { EmptyState } from '@/components/common/EmptyState';
import { SEO } from '@/components/SEO';
import { PrivateMentionRow } from '@/components/privateMentions/PrivateMentionRow';
import { usePrivateMentionConversations } from '@/hooks/usePrivateMentionConversations';

const ROW_HEIGHT = 72;

const conversationKey = (item: PrivateMentionConversation) => item.rootId;

/**
 * `/notifications/private-mentions` — the viewer's private-mention
 * conversations, newest activity first. Each row opens the conversation's
 * thread (`/p/:rootId`), which only its participants can read.
 */
export default function PrivateMentionsScreen() {
  const { t } = useTranslation();
  const { user, isAuthResolved, isPrivateApiPending, canUsePrivateApi } = useAuth();
  const {
    conversations,
    isLoading,
    isError,
    isRefetching,
    hasNextPage,
    isFetchingNextPage,
    loadMore,
    refetch,
  } = usePrivateMentionConversations();

  const renderItem = useCallback(
    ({ item }: { item: PrivateMentionConversation }) => (
      <PrivateMentionRow conversation={item} viewerId={user?.id} />
    ),
    [user?.id],
  );

  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // One list in every state, so Bloom pads each of them clear of the header.
  const renderEmpty = () => {
    if (!isAuthResolved || isPrivateApiPending || isLoading) {
      return <ChatListItemSkeleton count={8} />;
    }
    if (!canUsePrivateApi) {
      return (
        <OxyAuthPrompt
          label={t('privateMentions.signIn', {
            defaultValue: 'Sign in to see your private mentions',
          })}
        />
      );
    }
    if (isError) {
      return (
        <EmptyState
          error={{
            title: t('privateMentions.error.title', {
              defaultValue: "Couldn't load private mentions",
            }),
            message: t('privateMentions.error.message', {
              defaultValue: 'Check your connection and try again.',
            }),
            onRetry: async () => {
              await refetch();
            },
          }}
        />
      );
    }
    return (
      <EmptyState
        title={t('privateMentions.empty.title', { defaultValue: 'No private mentions yet' })}
        subtitle={t('privateMentions.empty.subtitle', {
          defaultValue:
            'Posts only you and the people mentioned can see will appear here. Start one from the composer by choosing "Private mention".',
        })}
        sticker="notificationsMentions"
      />
    );
  };

  return (
    <>
      <SEO
        title={t('privateMentions.title', { defaultValue: 'Private mentions' })}
        description={t('privateMentions.onlyMentioned', {
          defaultValue: 'Only visible to the people mentioned',
        })}
        robots="noindex,nofollow"
      />
      <Screen
        header={
          <PageHeader
            title={t('privateMentions.title', { defaultValue: 'Private mentions' })}
            backLabel={t('common.back', { defaultValue: 'Back' })}
          />
        }
      >
        <VirtualList
          screen={{}}
          data={canUsePrivateApi ? conversations : []}
          keyExtractor={conversationKey}
          renderItem={renderItem}
          estimatedItemSize={ROW_HEIGHT}
          onEndReached={hasNextPage ? loadMore : undefined}
          onEndReachedThreshold={0.5}
          refreshing={isRefetching}
          onRefresh={canUsePrivateApi ? handleRefresh : undefined}
          ListEmptyComponent={renderEmpty()}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View>
                <ChatListItemSkeleton count={2} />
              </View>
            ) : null
          }
        />
      </Screen>
    </>
  );
}
