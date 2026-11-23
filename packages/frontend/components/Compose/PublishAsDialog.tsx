import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle, type AccountNode } from '@oxy.so/core';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';
import { HStack, RawText, Toggle, VStack, toElement } from '@oxy.so/bloom-language';

import { Dialog as LDialog, Embed, Row, toElement as LtoElement } from '@oxy.so/bloom-language';

/** The row the post goes out as says so. */
const currentMark = (text: string) =>
  RawText(text).foreground('primary').font('sm').weight('semibold');

const PICKER_AVATAR_SIZE = 36;

interface PublishAsDialogProps {
  /** Whether the picker is on screen. Controlled by the composer. */
  open: boolean;
  /** The account the box being edited publishes as, or `null` for the author themselves. */
  selectedOxyUserId: string | null;
  /**
   * `null` publishes as the author, on their own profile, as always.
   *
   * The whole {@link AccountNode} rather than its id: the lane picker needs the
   * publisher's own role to know which of the two lane endpoints it may call, and
   * the composer already has the answer here — passing the id alone would buy a
   * second fetch of a list this dialog just read.
   */
  onSelect: (account: AccountNode | null) => void;
  onClose: () => void;
  /**
   * Whether a copy of the post is boosted onto the author's own profile.
   *
   * Optional because it is only a real question for a post the composer can
   * actually boost afterwards — a single post, published now. Omitted, the
   * switch is not drawn, rather than drawn and ignored. Whichever it is must not
   * change while the dialog is CLOSING: the panel is fully opaque for most of its
   * exit, so a prop that flips on dismissal reflows the card in front of an
   * author who just dismissed it.
   */
  alsoPostToProfile?: boolean;
  onAlsoPostToProfileChange?: (value: boolean) => void;
}

/**
 * Picks WHO one compose box is by — the author themselves, or another Oxy
 * account they may act for.
 *
 * The accounts come from the Oxy account graph rather than from a Mention-local
 * membership table, and choosing one makes the post AUTHORED BY it: that
 * account's avatar, name and handle sign the row because `post.user` IS the
 * account.
 *
 * Selecting one never switches the session. The caller stays themselves; only
 * the post's author changes. That is what makes this a per-post control instead
 * of an account switcher — and the only way a channel can author anything at
 * all, since `isDelegatedActAsEligibleKind` refuses to mint a session whose subject is a
 * channel.
 *
 * The second control follows from the first: the post lands on the CHOSEN
 * account's profile and in its followers' timelines, not on the author's own, so
 * "also post to my profile" is a real question. Its answer is a BOOST made after
 * the post publishes — Telegram's forward, a real row with the author as its
 * owner, which every surface already renders correctly.
 */
const PublishAsDialog = memo(function PublishAsDialog({
  open,
  selectedOxyUserId,
  onSelect,
  onClose,
  alsoPostToProfile,
  onAlsoPostToProfileChange,
}: PublishAsDialogProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();

  // Gated on `open` as well as on the session: the dialog stays mounted for the
  // whole compose so it can animate in and out, and a composer whose author never
  // touches the avatar — a reply, an edit, most posts — must not pay for the
  // account graph. Cached across opens, so only the first one waits.
  const { data: accounts = [], isLoading } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.accounts.list(),
    enabled: canUsePrivateApi && open,
  });

  // Every account the caller may act for EXCEPT their own, which the "Myself"
  // row above the list already is, and except the communities they moderate: a
  // community is posted IN (the composer's community chip), never published AS
  // — the server refuses it. Otherwise kind is not a filter here: the server
  // decides what the caller may publish as out of the account graph, and a UI
  // that narrowed it further would hide accounts it would have accepted.
  const otherAccounts = useMemo(
    () =>
      accounts.filter((account) => account.accountId !== user?.id && account.kind !== 'community'),
    [accounts, user?.id],
  );

  const handleSelect = useCallback(
    (account: AccountNode | null) => {
      onSelect(account);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleManage = useCallback(() => {
    onClose();
    router.push('/channels');
  }, [onClose, router]);

  return LtoElement(
    LDialog(
      Row(t('compose.publishAs.none', { defaultValue: 'Myself' }))
        .onPress(() => handleSelect(null))
        .leadingView(
          Embed(
            <AccountAvatar
              account={user ?? undefined}
              source={user?.avatar}
              size={PICKER_AVATAR_SIZE}
              variant={MEDIA_VARIANT_AVATAR}
              verified={Boolean(user?.verified)}
            />,
          ),
        )
        .subtitle(
          t('compose.publishAs.noneSubtitle', {
            defaultValue: 'The post goes out under your own name, as always',
          }),
        )
        .selected(selectedOxyUserId === null)
        .trailing(
          Embed(
            selectedOxyUserId === null
              ? toElement(currentMark(t('compose.publishAs.current', { defaultValue: 'Current' })))
              : undefined,
          ),
        ),
      Embed(
        isLoading ? (
          <ListSkeleton />
        ) : otherAccounts.length === 0 ? (
          toElement(
            RawText(
              t('compose.publishAs.empty', {
                defaultValue:
                  'You do not operate any other account yet. A channel is one people follow without following the people who write for it.',
              }),
            )
              .textAlign('center')
              .font('14')
              .leading('20px')
              .foreground('muted')
              .padding('vertical', '2xl')
              .padding('horizontal', '2xl'),
          )
        ) : (
          otherAccounts.map((account) => {
            const handle = getNormalizedUserHandle(account.account) ?? '';
            return LtoElement(
              Row(
                displayNameOrHandle(account.account.name?.displayName, handle ? `@${handle}` : ''),
              )
                .onPress(() => handleSelect(account))
                .leadingView(
                  Embed(
                    <AccountAvatar
                      account={account.account}
                      source={account.account.avatar}
                      size={PICKER_AVATAR_SIZE}
                      variant={MEDIA_VARIANT_AVATAR}
                      verified={Boolean(account.account.verified)}
                    />,
                  ),
                )
                .subtitle(handle ? `@${handle}` : undefined)
                .selected(account.accountId === selectedOxyUserId)
                .trailing(
                  Embed(
                    account.accountId === selectedOxyUserId
                      ? toElement(
                          currentMark(t('compose.publishAs.current', { defaultValue: 'Current' })),
                        )
                      : undefined,
                  ),
                ),
              account.accountId,
            );
          })
        ),
      ),
      /* The way OUT of an empty list. Without it the dialog explains what a
            channel is and offers no way to have one — which is exactly how the
            feature shipped when the old channels screen was deleted along with the
            model it read. */ Row(
        t('compose.publishAs.manage', { defaultValue: 'Create or manage channels' }),
      ).onPress(handleManage),
      /* Only a post published as somebody else can also be somewhere else — an
            ordinary post is already on the author's profile, so the question has no
            meaning there. */ Embed(
        selectedOxyUserId && alsoPostToProfile !== undefined && onAlsoPostToProfileChange
          ? toElement(
              HStack(
                VStack(
                  RawText(
                    t('compose.publishAs.alsoPostToProfile', {
                      defaultValue: 'Also post to my profile',
                    }),
                  )
                    .foreground('foreground')
                    .font('md')
                    .weight('semibold'),
                  RawText(
                    t('compose.publishAs.alsoPostToProfileHint', {
                      defaultValue: 'Reposts the post onto your own profile once it is published.',
                    }),
                  )
                    .foreground('muted')
                    .font('sm'),
                ).flex('1'),
                Toggle([alsoPostToProfile, onAlsoPostToProfileChange]),
              )
                .margin('top', 'sm')
                .align('center')
                .spacing('md')
                .padding('horizontal', 'md')
                .padding('vertical', 'md')
                .border('border', 'thin')
                .corner('lg'),
            )
          : null,
      ),
    )
      .title(t('compose.publishAs.title', { defaultValue: 'Post as' }))
      .label(t('compose.publishAs.title', { defaultValue: 'Post as' }))
      .presented([open, () => onClose()]),
  );
});

export default PublishAsDialog;
