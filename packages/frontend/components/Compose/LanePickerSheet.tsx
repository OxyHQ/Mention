import React, { memo, useCallback } from 'react';
import { FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import type { Lane } from '@mention/shared-types';
import { lanesService } from '@/services/lanesService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

interface LanePickerSheetProps {
  /** The lane currently chosen for this post, or `null` for none. */
  selectedLaneId: string | null;
  /** `null` clears the lane — the post goes out on no carriageway at all. */
  onSelect: (laneId: string | null) => void;
  /**
   * The account this post is being published AS, when it is not the author.
   *
   * A lane belongs to its PUBLISHER, and the publisher is whoever the post is
   * authored by — so a post published as a channel account has to offer THAT
   * account's lanes. The author's own lane on it is not merely irrelevant, it is
   * refused: the server checks a lane's owner before assigning it.
   */
  publishAs?: AccountNode | null;
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
  publishAs,
  onClose,
}: LanePickerSheetProps) {
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();

  // Only an account's OWNER may read its management list; a mere member gets the
  // public one, which is tab lanes only. The role comes off the account node the
  // composer already holds, so it costs no extra request — and asking the wrong
  // endpoint would answer 403 rather than an empty list.
  const managesPublisher =
    publishAs != null &&
    (publishAs.relationship === 'owner' || publishAs.callerMembership?.role === 'owner');

  const { data: lanes = [], isLoading } = useQuery<Lane[]>({
    queryKey: publishAs
      ? managesPublisher
        ? viewerQueryKeys.operatedLanes(user?.id, publishAs.accountId)
        : viewerQueryKeys.lanesForOwner(user?.id, publishAs.accountId)
      : viewerQueryKeys.ownedLanes(user?.id),
    queryFn: () => {
      if (!publishAs) return lanesService.listMine();
      return managesPublisher
        ? lanesService.listMine(publishAs.accountId)
        : lanesService.listForOwner(publishAs.accountId);
    },
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
      <PageHeader
        title={t('lanes.picker.title', { defaultValue: 'Post lane' })}
        titleAlign="center"
        safeArea={false}
        leading={
          <Button
            variant="secondary"
            iconOnly
            leadingIcon={RiCloseLine}
            onPress={onClose}
            accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
          />
        }
      />

      <Item
        onPress={() => handleSelect(null)}
        title={t('lanes.picker.none', { defaultValue: 'No lane' })}
        subtitle={
          publishAs
            ? t('lanes.picker.noneSubtitleChannel', {
                defaultValue: 'The post appears on the channel’s main tab',
              })
            : t('lanes.picker.noneSubtitle', {
                defaultValue: 'The post appears on your main profile tab',
              })
        }
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

      {/* `/lanes` manages the AUTHOR's lanes, which are not the ones listed while
          publishing as another account. A channel account's lanes have no
          management screen of their own yet, so the way out is omitted rather
          than pointed somewhere that would edit the wrong publisher's lanes. */}
      {publishAs ? null : (
        <View className="mt-2 mx-4">
          <Button variant="secondary" size="large" onPress={handleManage}>
            {t('lanes.picker.manage', { defaultValue: 'Manage lanes' })}
          </Button>
        </View>
      )}
    </View>
  );
});

export default LanePickerSheet;
