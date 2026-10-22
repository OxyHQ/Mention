import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountSettingsArchiveOptions } from '@oxy.so/services/screens';
import type { AccountNode } from '@oxy.so/core';

import { useRouter } from '@/lib/navigation/router';
import { confirmDialog } from '@/utils/alerts';
import { channelDeletionService } from '@/services/channelDeletionService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { OperatedAccountKind } from './OperatedAccountSettingsScreen';

/**
 * A CHANNEL's confirmation, COUNTED. A channel is a publication, and "are you
 * sure?" is not informed consent for destroying an archive: the body says how
 * many posts go, the button repeats it, and the rest names what a person could
 * otherwise be surprised by. The preview is read here rather than on mount: it
 * walks the channel's whole publishing history, and this dialog is its only
 * reader.
 */
async function confirmChannelDeletion(node: AccountNode, t: TFunction): Promise<boolean> {
  const counts = await channelDeletionService.preview(node.accountId);
  return confirmDialog({
    title: t('channels.settings.deleteConfirmTitle', {
      name: node.account.name?.displayName ?? '',
    }),
    message: [
      counts.posts > 0
        ? t('channels.settings.deleteConfirmPosts', { count: counts.posts })
        : t('channels.settings.deleteConfirmEmpty'),
      counts.boostsByOthers > 0
        ? t('channels.settings.deleteConfirmBoosts', { count: counts.boostsByOthers })
        : null,
      t('channels.settings.deleteConfirmFediverse'),
      t('channels.settings.deleteConfirmAccount'),
    ]
      .filter((sentence): sentence is string => sentence !== null)
      .join(' '),
    okText:
      counts.posts > 0
        ? t('channels.settings.deleteConfirmAction', { count: counts.posts })
        : t('channels.settings.deleteConfirmActionEmpty'),
    cancelText: t('common.cancel'),
    destructive: true,
  });
}

/**
 * What ending a member-operated account means in Mention, handed to Oxy's
 * `AccountSettings` — which owns the row, the archive and who may.
 *
 * A COMMUNITY is Oxy's archive alone: its posts are its MEMBERS', each authored
 * by the person who wrote it, so nothing of Mention's goes with it.
 *
 * A CHANNEL takes its published posts with it, and the order is forced: Oxy's
 * account reads exclude an archived account, and Mention's cascade resolves the
 * channel's kind and username through exactly those reads — archive first and
 * every post it published is stranded with nothing left that can address a
 * deletion for it. So the posts go in `beforeArchive`, and a failure there
 * stops the archive, leaving the survivable state (fewer posts, account still
 * standing) that a retry converges from, because the cascade is idempotent.
 */
export function useOperatedAccountArchive(
  kind: OperatedAccountKind,
): AccountSettingsArchiveOptions {
  const router = useRouter();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const viewerId = user?.id;

  return useMemo(() => {
    const onArchived = () => {
      // Every list that enumerates the caller's accounts — the settings gate,
      // the composer's publish-as picker, the Channels and Communities screens —
      // reads this key, and the account is gone from all of them.
      void queryClient.invalidateQueries({ queryKey: viewerQueryKeys.operatedAccounts(viewerId) });
      // Home rather than back: back is the account's own page, which no longer
      // resolves.
      router.replace('/');
    };
    if (kind === 'community') return { onArchived };
    return {
      title: t('channels.settings.delete'),
      footer: t('channels.settings.deleteFooter'),
      successMessage: t('channels.settings.deleted'),
      confirm: (node) => confirmChannelDeletion(node, t),
      beforeArchive: async (node) => {
        await channelDeletionService.deleteContent(node.accountId);
      },
      onArchived,
    };
  }, [kind, queryClient, router, t, viewerId]);
}
