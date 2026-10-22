import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Item } from '@oxy.so/bloom/item';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import type { CommunityBan } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useSafeBack } from '@/hooks/useSafeBack';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { communityService } from '@/services/communityService';
import { displayNameOrHandle } from '@/utils/displayName';
import { FocusedScrollView } from '@/components/common/FocusedScrollView';
import { SignInRequired } from '@/components/common/SignInRequired';
import { CommunitiesPreviewGate } from '@/hooks/useCommunitiesPreview';

/**
 * Who a community's moderators banned from posting in it, and the way to lift a
 * ban. Bans are made from a post's menu; the server decides who may read or
 * change this list (`assertCanModerateCommunity`), so a non-moderator sees its
 * refusal rather than a list.
 */
function CommunityBansScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();
  const { user, canUsePrivateApi } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const communityId = typeof id === 'string' ? id : '';
  const queryKey = viewerQueryKeys.communityBans(user?.id, communityId);

  const {
    data: bans = [],
    isLoading,
    isError,
  } = useQuery<CommunityBan[]>({
    queryKey,
    queryFn: () => communityService.bans(communityId),
    enabled: canUsePrivateApi && communityId.length > 0,
  });

  const unban = useMutation({
    mutationFn: (userId: string) => communityService.unban(communityId, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      toast.success(t('communities.unbanned', { defaultValue: 'Ban lifted' }));
    },
    onError: (error) => {
      logger.error('[Communities] Failed to lift a ban', error);
      toast.error(t('communities.unbanFailed', { defaultValue: 'Could not lift the ban' }));
    },
  });

  const renderBan = useCallback(
    (ban: CommunityBan) => {
      const handle = getNormalizedUserHandle(ban.user) ?? '';
      return (
        <Item
          key={ban.user.id}
          leading={<Avatar source={ban.user.avatar} size={36} variant={MEDIA_VARIANT_AVATAR} />}
          title={displayNameOrHandle(ban.user.name?.displayName, handle ? `@${handle}` : '')}
          subtitle={ban.reason ?? (handle ? `@${handle}` : undefined)}
          trailing={
            <Button
              size="sm"
              appearance="subtle"
              tone="neutral"
              disabled={unban.isPending}
              onPress={() => unban.mutate(ban.user.id)}
            >
              {t('communities.unban', { defaultValue: 'Lift ban' })}
            </Button>
          }
        />
      );
    },
    [t, unban],
  );

  return (
    <View className="flex-1">
      <PageHeader
        title={t('communities.bansTitle', { defaultValue: 'Banned from this community' })}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />
      <SignInRequired
        label={t('communities.signInRequired', {
          defaultValue: 'Sign in to manage your communities',
        })}
      >
        <FocusedScrollView className="flex-1" contentContainerClassName="pb-10">
          {isLoading ? (
            <View className="py-8">
              <ListSkeleton />
            </View>
          ) : isError ? (
            <Text className="text-muted-foreground text-[14px] px-4 py-6">
              {t('communities.bansUnavailable', {
                defaultValue: 'Only the moderators of this community can see who is banned.',
              })}
            </Text>
          ) : bans.length === 0 ? (
            <Text className="text-muted-foreground text-[14px] px-4 py-6">
              {t('communities.noBans', { defaultValue: 'Nobody is banned from this community.' })}
            </Text>
          ) : (
            bans.map(renderBan)
          )}
        </FocusedScrollView>
      </SignInRequired>
    </View>
  );
}

export default function CommunityBansRoute() {
  return (
    <CommunitiesPreviewGate>
      <CommunityBansScreen />
    </CommunitiesPreviewGate>
  );
}
