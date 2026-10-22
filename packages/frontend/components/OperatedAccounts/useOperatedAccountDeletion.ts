import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { createLogger } from '@oxy.so/core/logger';
import type { AccountNode } from '@oxy.so/core';

import { useRouter } from '@/lib/navigation/router';
import { confirmDialog } from '@/utils/alerts';
import { channelDeletionService } from '@/services/channelDeletionService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getErrorMessage } from '@/utils/apiError';
import type {
  OperatedAccountKind,
  OperatedAccountSettingsCopy,
} from './operatedAccountSettingsCopy';

const deletionLogger = createLogger('OperatedAccountDeletion');

/**
 * The Oxy account permission that authorises ending an account, and therefore
 * the one thing that decides whether the settings screen offers to.
 *
 * Oxy grants it to the `owner` role ALONE, so it is strictly narrower than being
 * able to operate the account: an `admin` or `editor` reaches the screen and
 * edits the profile, and may not delete. Read off the membership Oxy resolved
 * rather than inferred from `callerMembership.role`, because a role list here
 * would be a second copy of Oxy's role to permission map.
 *
 * A literal because it is a WIRE value — neither `@oxy.so/contracts` nor
 * `@oxy.so/core` exports the vocabulary today. The backend keeps the same
 * constant for the same reason (`services/publishAsAccount.ts`).
 */
const ACCOUNT_DELETE_PERMISSION = 'account:delete';

/**
 * Whether the caller may end this account. `=== true`: an absent or malformed
 * permission array is a refusal, because this decides whether a destructive
 * control appears at all.
 */
export function canDeleteOperatedAccount(node: AccountNode): boolean {
  return node.callerMembership?.permissions?.includes(ACCOUNT_DELETE_PERMISSION) === true;
}

/**
 * Backing out at the confirmation is a normal outcome, not an error — a
 * rejection would put a "failed to delete" toast in front of somebody who just
 * decided not to.
 */
interface DeletionOutcome {
  deleted: boolean;
}

interface DeletionContext {
  accountId: string;
  name: string;
  t: TFunction;
  archive: (accountId: string) => Promise<unknown>;
}

/**
 * A CHANNEL: Mention's rows, then Oxy's account, in that order, behind a
 * COUNTED confirmation.
 *
 * The order is forced. Oxy's account reads exclude an archived account, and
 * Mention's cascade resolves the channel's kind and username through exactly
 * those reads — archive first and every post it published is stranded with
 * nothing left that can address a deletion for it. A failure between the two
 * halves leaves the survivable state (no posts, account still standing) that a
 * retry converges from, because the cascade is idempotent.
 *
 * The preview is fetched here rather than on mount: it walks the channel's whole
 * publishing history, and its only consumer is this dialog.
 */
async function deleteChannel({ accountId, name, t, archive }: DeletionContext) {
  const counts = await channelDeletionService.preview(accountId);
  // A channel is a publication, and "are you sure?" is not informed consent for
  // destroying an archive: the body says how many posts go, the button repeats
  // it, and the rest names what a person could otherwise be surprised by.
  const confirmed = await confirmDialog({
    title: t('channels.settings.deleteConfirmTitle', { name }),
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
  if (!confirmed) return { deleted: false };

  await channelDeletionService.deleteContent(accountId);
  // Oxy's half, and ONLY now: see the order argument above.
  await archive(accountId);
  return { deleted: true };
}

/**
 * A COMMUNITY: Oxy's account alone. Its posts are its MEMBERS' — each one is
 * authored by the person who wrote it and merely points at the community — so
 * there is no Mention content to cascade first, and nothing is destroyed but the
 * place they were posted in.
 */
async function deleteCommunity({ accountId, name, t, archive }: DeletionContext) {
  const confirmed = await confirmDialog({
    title: t('communities.settings.deleteConfirmTitle', { name }),
    message: t('communities.settings.deleteConfirmMessage'),
    okText: t('communities.settings.deleteConfirmAction'),
    cancelText: t('common.cancel'),
    destructive: true,
  });
  if (!confirmed) return { deleted: false };
  await archive(accountId);
  return { deleted: true };
}

const DELETE_BY_KIND: Record<
  OperatedAccountKind,
  (context: DeletionContext) => Promise<DeletionOutcome>
> = {
  channel: deleteChannel,
  community: deleteCommunity,
};

/**
 * Ending a member-operated account, as one mutation: the question and every
 * destructive call it guards are one decision, so splitting them across
 * handlers is how a destructive call becomes reachable without the question.
 */
export function useOperatedAccountDeletion(
  node: AccountNode,
  kind: OperatedAccountKind,
  copy: OperatedAccountSettingsCopy,
) {
  const router = useRouter();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { user, oxyServices } = useAuth();
  const accountId = node.accountId;

  return useMutation<DeletionOutcome, unknown, void>({
    mutationFn: () =>
      DELETE_BY_KIND[kind]({
        accountId,
        name: node.account.name?.displayName ?? '',
        t,
        archive: (id) => oxyServices.accounts.archive(id),
      }),
    onSuccess: (outcome) => {
      if (!outcome.deleted) return;
      // Every list that enumerates the caller's accounts — the settings gate,
      // the composer's publish-as picker, the Channels and Communities screens —
      // reads this key, and the account is gone from all of them.
      queryClient.invalidateQueries({ queryKey: viewerQueryKeys.operatedAccounts(user?.id) });
      toast.success(copy.deleted);
      // Home rather than back: back is the account's own page, which no longer
      // resolves.
      router.replace('/');
    },
    onError: (error) => {
      deletionLogger.error(copy.deleteFailed, error, { accountId, kind });
      toast(getErrorMessage(error, copy.deleteFailed), { type: 'error' });
    },
  });
}
