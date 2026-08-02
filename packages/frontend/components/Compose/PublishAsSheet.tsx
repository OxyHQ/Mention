import React, { memo, useCallback, useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Item } from '@oxyhq/bloom/item';
import { Loading } from '@oxyhq/bloom/loading';
import { Switch } from '@oxyhq/bloom/switch';
import { useAuth } from '@oxyhq/services/ui/client';
import type { AccountNode } from '@oxyhq/core';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';

interface PublishAsSheetProps {
  /** The account currently chosen to publish as, or `null` for the author themselves. */
  selectedOxyUserId: string | null;
  /**
   * `null` publishes as the author, on their own profile, as always.
   *
   * The whole {@link AccountNode} rather than its id: the lane picker needs the
   * publisher's own id to list the right lanes, and the composer already has the
   * answer here — passing the id alone would buy a second fetch of a list this
   * sheet just read.
   */
  onSelect: (account: AccountNode | null) => void;
  /** Whether a copy of the channel's post is boosted onto the author's own profile. */
  alsoPostToProfile: boolean;
  onAlsoPostToProfileChange: (value: boolean) => void;
  onClose: () => void;
}

const keyExtractor = (account: AccountNode) => account.accountId;

/**
 * Picks WHO the post is by — the author themselves, or a channel account they
 * operate.
 *
 * A channel is an Oxy account, so this list comes from the Oxy account graph
 * rather than from a Mention-local membership table, and choosing one makes the
 * post AUTHORED BY it: the channel's avatar, name and handle sign the row
 * because `post.user` is the channel.
 *
 * A channel can never be acted as — it is a content identity, not a seat — so
 * this sheet is how a post comes to be authored by one, rather than a session
 * switch.
 *
 * The second control follows from the first: the post lands on the CHANNEL's
 * profile and in the channel's followers' timelines, not on the author's own, so
 * "also post to my profile" is a real question. Its answer is a BOOST of the
 * channel's post made after it publishes — Telegram's forward, a real row with
 * the author as its owner, which every surface already renders correctly.
 */
const PublishAsSheet = memo(function PublishAsSheet({
  selectedOxyUserId,
  onSelect,
  alsoPostToProfile,
  onAlsoPostToProfileChange,
  onClose,
}: PublishAsSheetProps) {
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();

  const { data: accounts = [], isLoading } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.listAccounts(),
    enabled: canUsePrivateApi,
  });

  // Only channel accounts publish. The other kinds in the graph are seats and
  // principals — an organization or a bot is switched INTO, and a post authored
  // by one comes from that session rather than from this field.
  const channels = useMemo(
    () => accounts.filter((account) => account.kind === 'channel'),
    [accounts],
  );

  const handleSelect = useCallback(
    (account: AccountNode | null) => {
      onSelect(account);
      onClose();
    },
    [onSelect, onClose],
  );

  const renderItem = useCallback(
    ({ item }: { item: AccountNode }) => {
      const handle = getNormalizedUserHandle(item.account) ?? '';
      return (
        <Item
          onPress={() => handleSelect(item)}
          title={displayNameOrHandle(item.account.name?.displayName, handle ? `@${handle}` : '')}
          subtitle={handle ? `@${handle}` : undefined}
          trailing={
            item.accountId === selectedOxyUserId ? (
              <Text className="text-primary text-[13px] font-semibold">
                {t('channels.picker.current', { defaultValue: 'Current' })}
              </Text>
            ) : undefined
          }
        />
      );
    },
    [handleSelect, selectedOxyUserId, t],
  );

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border">
        <IconButton variant="icon" onPress={onClose} className="mr-1.5 z-[1]">
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('channels.picker.title', { defaultValue: 'Post as' })}
        </Text>
        <View className="w-9 h-9 ml-auto" />
      </View>

      <Item
        onPress={() => handleSelect(null)}
        title={t('channels.picker.none', { defaultValue: 'Myself' })}
        subtitle={t('channels.picker.noneSubtitle', {
          defaultValue: 'The post goes out under your own name, as always',
        })}
        trailing={
          selectedOxyUserId === null ? (
            <Text className="text-primary text-[13px] font-semibold">
              {t('channels.picker.current', { defaultValue: 'Current' })}
            </Text>
          ) : undefined
        }
      />

      {isLoading ? (
        <View className="py-10 items-center">
          <Loading className="text-primary" size="large" style={{ flex: undefined }} />
        </View>
      ) : (
        <FlatList
          data={channels}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text className="text-center text-sm text-muted-foreground py-6 px-6">
              {t('channels.picker.empty', {
                defaultValue:
                  'A channel is an account people follow without following the people who write for it. You publish as the ones you operate.',
              })}
            </Text>
          }
        />
      )}

      {/* Only a post published as somebody else can also be somewhere else — an
          ordinary post is already on the author's profile, so the question has no
          meaning there. */}
      {selectedOxyUserId ? (
        <View className="mx-4 mt-2 flex-row items-center gap-3 rounded-2xl border border-border px-3 py-3">
          <View className="flex-1">
            <Text className="text-foreground text-[15px] font-semibold">
              {t('channels.picker.alsoPostToProfile', { defaultValue: 'Also post to my profile' })}
            </Text>
            <Text className="text-muted-foreground text-[13px]">
              {t('channels.picker.alsoPostToProfileHint', {
                defaultValue: 'Reposts the channel’s post onto your own profile once it is published.',
              })}
            </Text>
          </View>
          <Switch value={alsoPostToProfile} onValueChange={onAlsoPostToProfileChange} />
        </View>
      ) : null}
    </View>
  );
});

export default PublishAsSheet;
