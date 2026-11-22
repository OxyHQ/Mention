import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { Screen } from '@oxy.so/bloom/screen';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import type { CommunityBan } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { communityService } from '@/services/communityService';
import { displayNameOrHandle } from '@/utils/displayName';
import { SignInRequired } from '@/components/common/SignInRequired';
import { CommunitiesPreviewGate } from '@/hooks/useCommunitiesPreview';

import {
  Avatar as LAvatar,
  Button as LButton,
  Embed,
  Header,
  RawText,
  Row,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/**
 * Who a community's moderators banned from posting in it, and the way to lift a
 * ban. Bans are made from a post's menu; the server decides who may read or
 * change this list (`assertCanModerateCommunity`), so a non-moderator sees its
 * refusal rather than a list.
 */
function CommunityBansScreen() {
  const { t } = useTranslation();
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
      return toElement(
        Row(displayNameOrHandle(ban.user.name?.displayName, handle ? `@${handle}` : ''))
          .leadingView(LAvatar(ban.user.avatar, { variant: MEDIA_VARIANT_AVATAR }).size('lg'))
          .subtitle(ban.reason ?? (handle ? `@${handle}` : undefined))
          .trailing(
            LButton(LText(t('communities.unban', { defaultValue: 'Lift ban' })))
              .size('sm')
              .style('subtle')
              .tint('neutral')
              .disabled(unban.isPending)
              .onPress(() => unban.mutate(ban.user.id)),
          ),
        ban.user.id,
      );
    },
    [t, unban],
  );

  return (
    <Screen
      header={toElement(
        Header(t('communities.bansTitle', { defaultValue: 'Banned from this community' }))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
      )}
    >
      <SignInRequired
        label={t('communities.signInRequired', {
          defaultValue: 'Sign in to manage your communities',
        })}
      >
        {toElement(
          ScrollView(
            Embed(
              isLoading
                ? toElement(VStack(Embed(<ListSkeleton />)).padding('vertical', '3xl'))
                : isError
                  ? toElement(
                      RawText(
                        t('communities.bansUnavailable', {
                          defaultValue:
                            'Only the moderators of this community can see who is banned.',
                        }),
                      )
                        .padding('horizontal', 'lg')
                        .padding('vertical', '2xl')
                        .foreground('muted')
                        .font('14'),
                    )
                  : bans.length === 0
                    ? toElement(
                        RawText(
                          t('communities.noBans', {
                            defaultValue: 'Nobody is banned from this community.',
                          }),
                        )
                          .padding('horizontal', 'lg')
                          .padding('vertical', '2xl')
                          .foreground('muted')
                          .font('14'),
                      )
                    : bans.map(renderBan),
            ),
          ).contentView((v) => v.padding('bottom', '4xl')),
        )}
      </SignInRequired>
    </Screen>
  );
}

export default function CommunityBansRoute() {
  return (
    <CommunitiesPreviewGate>
      <CommunityBansScreen />
    </CommunitiesPreviewGate>
  );
}
