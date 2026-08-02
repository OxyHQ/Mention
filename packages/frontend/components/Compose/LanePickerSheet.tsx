import React, { memo, useCallback } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Item } from '@oxyhq/bloom/item';
import { Loading } from '@oxyhq/bloom/loading';
import { useAuth } from '@oxyhq/services/ui/client';
import type { Lane } from '@mention/shared-types';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { lanesService } from '@/services/lanesService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

interface LanePickerSheetProps {
  /** The lane currently chosen for this post, or `null` for none. */
  selectedLaneId: string | null;
  /** `null` clears the lane — the post goes out on no carriageway at all. */
  onSelect: (laneId: string | null) => void;
  onClose: () => void;
}

const keyExtractor = (lane: Lane) => lane.id;

/**
 * Picks the author's own lane for the post being written.
 *
 * A sheet rather than an inline panel (the shape `LanguagePickerSheet` uses, not
 * `CollaboratorPicker`'s): choosing a lane is one tap on a short list the author
 * already owns, with nothing to search and nothing to assemble, so it does not
 * earn permanent room under the composer.
 *
 * "No lane" is a real, listed choice and not just the absence of one — an author
 * who tapped in to change their mind needs a way back out that is as obvious as
 * the way in.
 */
const LanePickerSheet = memo(function LanePickerSheet({
  selectedLaneId,
  onSelect,
  onClose,
}: LanePickerSheetProps) {
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();

  const { data: lanes = [], isLoading } = useQuery<Lane[]>({
    queryKey: viewerQueryKeys.ownedLanes(user?.id),
    queryFn: () => lanesService.listMine(),
    enabled: canUsePrivateApi,
  });

  const handleSelect = useCallback(
    (laneId: string | null) => {
      onSelect(laneId);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleManage = useCallback(() => {
    onClose();
    router.push('/lanes');
  }, [onClose]);

  const renderItem = useCallback(
    ({ item }: { item: Lane }) => (
      <Item
        onPress={() => handleSelect(item.id)}
        title={item.name}
        subtitle={t('lanes.postCount', {
          count: item.postCount ?? 0,
          defaultValue: '{{count}} posts',
        })}
        trailing={
          item.id === selectedLaneId ? (
            <Text className="text-primary text-[13px] font-semibold">
              {t('lanes.picker.current', { defaultValue: 'Current' })}
            </Text>
          ) : undefined
        }
      />
    ),
    [handleSelect, selectedLaneId, t],
  );

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border">
        <IconButton variant="icon" onPress={onClose} className="mr-1.5 z-[1]">
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('lanes.picker.title', { defaultValue: 'Post lane' })}
        </Text>
        <View className="w-9 h-9 ml-auto" />
      </View>

      <Item
        onPress={() => handleSelect(null)}
        title={t('lanes.picker.none', { defaultValue: 'No lane' })}
        subtitle={t('lanes.picker.noneSubtitle', {
          defaultValue: 'The post appears on your main profile tab',
        })}
        trailing={
          selectedLaneId === null ? (
            <Text className="text-primary text-[13px] font-semibold">
              {t('lanes.picker.current', { defaultValue: 'Current' })}
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
          data={lanes}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text className="text-center text-sm text-muted-foreground py-6 px-6">
              {t('lanes.picker.empty', {
                defaultValue: 'Lanes let you keep separate tracks of your posts and decide which ones reach your profile.',
              })}
            </Text>
          }
        />
      )}

      <View className="mt-2 mx-4">
        <TouchableOpacity
          onPress={handleManage}
          className="flex-row items-center justify-center py-3 rounded-full border border-border"
          activeOpacity={0.85}
        >
          <Text className="text-sm font-semibold text-primary">
            {t('lanes.picker.manage', { defaultValue: 'Manage lanes' })}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

export default LanePickerSheet;
