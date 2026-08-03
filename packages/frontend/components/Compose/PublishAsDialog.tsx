import React, { memo, useCallback, useMemo } from 'react';
import { Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Dialog } from '@oxyhq/bloom/dialog';
import { Item } from '@oxyhq/bloom/item';
import { Loading } from '@oxyhq/bloom/loading';
import { Switch } from '@oxyhq/bloom/switch';
import { useAuth } from '@oxyhq/services/ui/client';
import { getNormalizedUserHandle, type AccountNode } from '@oxyhq/core';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';

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
 * all, since `isActAsEligibleKind` refuses to mint a session whose subject is a
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
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();

  // Gated on `open` as well as on the session: the dialog stays mounted for the
  // whole compose so it can animate in and out, and a composer whose author never
  // touches the avatar — a reply, an edit, most posts — must not pay for the
  // account graph. Cached across opens, so only the first one waits.
  const { data: accounts = [], isLoading } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.listAccounts(),
    enabled: canUsePrivateApi && open,
  });

  // Every account the caller may act for EXCEPT their own, which the "Myself"
  // row above the list already is. Kind is not a filter here: the server decides
  // what the caller may publish as out of the account graph, and a UI that
  // narrowed it further would hide accounts it would have accepted.
  const otherAccounts = useMemo(
    () => accounts.filter((account) => account.accountId !== user?.id),
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
  }, [onClose]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('compose.publishAs.title', { defaultValue: 'Post as' })}
      label={t('compose.publishAs.title', { defaultValue: 'Post as' })}
    >
      <Item
        onPress={() => handleSelect(null)}
        leading={
          <Avatar
            source={user?.avatar}
            size={PICKER_AVATAR_SIZE}
            variant={MEDIA_VARIANT_AVATAR}
            verified={Boolean(user?.verified)}
          />
        }
        title={t('compose.publishAs.none', { defaultValue: 'Myself' })}
        subtitle={t('compose.publishAs.noneSubtitle', {
          defaultValue: 'The post goes out under your own name, as always',
        })}
        selected={selectedOxyUserId === null}
        trailing={
          selectedOxyUserId === null ? (
            <Text className="text-primary text-[13px] font-semibold">
              {t('compose.publishAs.current', { defaultValue: 'Current' })}
            </Text>
          ) : undefined
        }
      />

      {isLoading ? (
        <View className="py-10 items-center">
          <Loading className="text-primary" size="large" style={{ flex: undefined }} />
        </View>
      ) : otherAccounts.length === 0 ? (
        <Text className="text-center text-sm text-muted-foreground py-6 px-6">
          {t('compose.publishAs.empty', {
            defaultValue:
              'You do not operate any other account yet. A channel is one people follow without following the people who write for it.',
          })}
        </Text>
      ) : (
        otherAccounts.map((account) => {
          const handle = getNormalizedUserHandle(account.account) ?? '';
          return (
            <Item
              key={account.accountId}
              onPress={() => handleSelect(account)}
              leading={
                <Avatar
                  source={account.account.avatar}
                  size={PICKER_AVATAR_SIZE}
                  variant={MEDIA_VARIANT_AVATAR}
                  verified={Boolean(account.account.verified)}
                />
              }
              title={displayNameOrHandle(
                account.account.name?.displayName,
                handle ? `@${handle}` : '',
              )}
              subtitle={handle ? `@${handle}` : undefined}
              selected={account.accountId === selectedOxyUserId}
              trailing={
                account.accountId === selectedOxyUserId ? (
                  <Text className="text-primary text-[13px] font-semibold">
                    {t('compose.publishAs.current', { defaultValue: 'Current' })}
                  </Text>
                ) : undefined
              }
            />
          );
        })
      )}

      {/* The way OUT of an empty list. Without it the dialog explains what a
          channel is and offers no way to have one — which is exactly how the
          feature shipped when the old channels screen was deleted along with the
          model it read. */}
      <Item
        onPress={handleManage}
        title={t('compose.publishAs.manage', { defaultValue: 'Create or manage channels' })}
      />

      {/* Only a post published as somebody else can also be somewhere else — an
          ordinary post is already on the author's profile, so the question has no
          meaning there. */}
      {selectedOxyUserId && alsoPostToProfile !== undefined && onAlsoPostToProfileChange ? (
        <View className="mt-2 flex-row items-center gap-3 rounded-2xl border border-border px-3 py-3">
          <View className="flex-1">
            <Text className="text-foreground text-[15px] font-semibold">
              {t('compose.publishAs.alsoPostToProfile', { defaultValue: 'Also post to my profile' })}
            </Text>
            <Text className="text-muted-foreground text-[13px]">
              {t('compose.publishAs.alsoPostToProfileHint', {
                defaultValue: 'Reposts the post onto your own profile once it is published.',
              })}
            </Text>
          </View>
          <Switch value={alsoPostToProfile} onValueChange={onAlsoPostToProfileChange} />
        </View>
      ) : null}
    </Dialog>
  );
});

export default PublishAsDialog;
