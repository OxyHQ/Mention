import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { toast } from '@oxy.so/bloom/toast';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';
import { createLogger } from '@oxy.so/core/logger';

import {
  channelAccountService,
  type ChannelAccountSettings,
} from '@/services/channelAccountService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getErrorMessage } from '@/utils/apiError';

import { Icon, toElement } from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { Toggle } from '@oxy.so/bloom-language/inputs';

const bylineLogger = createLogger('ChannelBylineSettings');

/**
 * A CHANNEL's byline — whether a post names the person who wrote it. The one
 * channel setting Oxy has no concept of, so it is Mention's, and it goes through
 * `PUT /profile/settings/:userId`. A community has no equivalent: its posts are
 * signed by the members who wrote them. Rendered inside Oxy's `AccountSettings`
 * as one of its sections, so it is built from the same Bloom group.
 */
export function ChannelBylineSettings({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const settingsQueryKey = viewerQueryKeys.channelAccountSettings(user?.id, accountId);
  const { data: settings, isPending } = useQuery<ChannelAccountSettings>({
    queryKey: settingsQueryKey,
    queryFn: () => channelAccountService.getSettings(accountId),
  });

  const signPostsMutation = useMutation<ChannelAccountSettings, unknown, boolean>({
    mutationFn: (signPosts) => channelAccountService.setSignPosts(accountId, signPosts),
    // Written straight into the cache: the server already answered, and a
    // refetch would repaint the screen for one boolean.
    onSuccess: (applied) => queryClient.setQueryData(settingsQueryKey, applied),
    onError: (error) => {
      const fallback = t('channels.settings.saveFailed');
      bylineLogger.error(fallback, error, { accountId });
      toast(getErrorMessage(error, fallback), { type: 'error' });
    },
  });

  const handleSignPostsChange = useCallback(
    (value: boolean) => signPostsMutation.mutate(value),
    [signPostsMutation],
  );

  return toElement(
    LGroupedSection(
      LGroupedSectionItem(t('channels.settings.signPosts'))
        .leadingView(Icon(RiUserLine).size('md').foreground('muted'))
        .chevron(false)
        .trailing(
          Toggle([settings?.signPosts === true, handleSignPostsChange]).disabled(
            isPending || signPostsMutation.isPending,
          ),
        ),
    )
      .title(t('channels.settings.byline'))
      .caption(t('channels.settings.signPostsFooter')),
  );
}
