import React, { memo, useCallback } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Item } from '@oxyhq/bloom/item';
import { Loading } from '@oxyhq/bloom/loading';
import { Switch } from '@oxyhq/bloom/switch';
import { useAuth } from '@oxyhq/services/ui/client';
import type { Channel } from '@mention/shared-types';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { channelsService } from '@/services/channelsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

interface ChannelPickerSheetProps {
  /** The channel currently chosen for this post, or `null` for the author's own profile. */
  selectedChannelId: string | null;
  /**
   * `null` publishes as the author, on their own profile, as always.
   *
   * The whole {@link Channel} rather than its id: the lane picker needs the
   * channel's owner to know which of the two lane endpoints it may call, and the
   * composer already has the answer here — passing the id alone would buy a
   * second fetch of a list this sheet just read.
   */
  onSelect: (channel: Channel | null) => void;
  /** Whether a copy of the channel post is boosted onto the author's own profile. */
  alsoPostToProfile: boolean;
  onAlsoPostToProfileChange: (value: boolean) => void;
  onClose: () => void;
}

const keyExtractor = (channel: Channel) => channel.id;

/**
 * Picks the DESTINATION of the post being written — the author's own profile, or
 * one of the channels they may publish to.
 *
 * A sheet, the shape `LanePickerSheet` uses: a short list the author already
 * belongs to, one tap, nothing to search.
 *
 * It is a destination and not a lens, which is what the second control is about.
 * A channel post exists ONLY in the channel — not on the author's profile, not in
 * their followers' timeline — so "also post to my profile" is a real question
 * rather than a formality, and its answer is a BOOST of the channel post made
 * after it publishes. That is Telegram's forward, it renders correctly already,
 * and it means there is no second flag on the post for the two surfaces to
 * disagree about.
 */
const ChannelPickerSheet = memo(function ChannelPickerSheet({
  selectedChannelId,
  onSelect,
  alsoPostToProfile,
  onAlsoPostToProfileChange,
  onClose,
}: ChannelPickerSheetProps) {
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();

  const { data: channels = [], isLoading } = useQuery<Channel[]>({
    queryKey: viewerQueryKeys.ownedChannels(user?.id),
    queryFn: () => channelsService.listMine(),
    enabled: canUsePrivateApi,
  });

  const handleSelect = useCallback(
    (channel: Channel | null) => {
      onSelect(channel);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleBrowse = useCallback(() => {
    onClose();
    router.push('/channels');
  }, [onClose]);

  const renderItem = useCallback(
    ({ item }: { item: Channel }) => (
      <Item
        onPress={() => handleSelect(item)}
        title={item.title}
        subtitle={`@${item.handle}`}
        trailing={
          item.id === selectedChannelId ? (
            <Text className="text-primary text-[13px] font-semibold">
              {t('channels.picker.current', { defaultValue: 'Current' })}
            </Text>
          ) : undefined
        }
      />
    ),
    [handleSelect, selectedChannelId, t],
  );

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border">
        <IconButton variant="icon" onPress={onClose} className="mr-1.5 z-[1]">
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('channels.picker.title', { defaultValue: 'Post to' })}
        </Text>
        <View className="w-9 h-9 ml-auto" />
      </View>

      <Item
        onPress={() => handleSelect(null)}
        title={t('channels.picker.none', { defaultValue: 'My profile' })}
        subtitle={t('channels.picker.noneSubtitle', {
          defaultValue: 'The post goes out under your own name, as always',
        })}
        trailing={
          selectedChannelId === null ? (
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
                defaultValue: 'A channel is a publication people follow without following its authors. You publish to the ones you own or were invited to.',
              })}
            </Text>
          }
        />
      )}

      {/* Only a channel post can also be somewhere else — an ordinary post is
          already on the author's profile, so the question has no meaning there. */}
      {selectedChannelId ? (
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

      <View className="mt-2 mx-4">
        <TouchableOpacity
          onPress={handleBrowse}
          className="flex-row items-center justify-center py-3 rounded-full border border-border"
          activeOpacity={0.85}
        >
          <Text className="text-sm font-semibold text-primary">
            {t('channels.picker.manage', { defaultValue: 'Browse channels' })}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

export default ChannelPickerSheet;
