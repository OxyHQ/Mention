import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback } from 'react';
import { FlatList } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiNodeTree } from '@oxy.so/bloom/icons/RiNodeTree';
import type { AccountNode } from '@oxy.so/core';
import type { Lane } from '@mention/shared-types';
import { usePublisherLanes } from '@/hooks/usePublisherLanes';
import { EmptyState } from '@/components/common/EmptyState';

import {
  Button as LButton,
  Embed,
  Header,
  Icon,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Row } from '@oxy.so/bloom-language/containers';

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
  const router = useRouter();
  const { t } = useTranslation();

  const { lanes, isLoading } = usePublisherLanes(publishAs);

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
  }, [onClose, router]);

  const renderItem = useCallback(
    ({ item }: { item: Lane }) =>
      toElement(
        Row(item.name)
          .onPress(() => handleSelect(item.id))
          .subtitle(
            t('lanes.postCount', {
              count: item.postCount ?? 0,
              defaultValue: '{{count}} posts',
            }),
          )
          .trailing(
            Embed(
              item.id === selectedLaneId
                ? toElement(
                    RawText(t('lanes.picker.current', { defaultValue: 'Current' }))
                      .foreground('primary')
                      .font('sm')
                      .weight('semibold'),
                  )
                : undefined,
            ),
          ),
      ),
    [handleSelect, selectedLaneId, t],
  );

  return toElement(
    VStack(
      Header(t('lanes.picker.title', { defaultValue: 'Post lane' }))
        .titleAlign('center')
        .safeArea(false)
        .toolbarLeading(
          LButton(Icon(RiCloseLine))
            .shape('circle')
            .style('subtle')
            .tint('neutral')
            .onPress(onClose)
            .label(t('common.close', { defaultValue: 'Close' })),
        )
        .inPage(),
      Row(t('lanes.picker.none', { defaultValue: 'No lane' }))
        .onPress(() => handleSelect(null))
        .subtitle(
          publishAs
            ? t('lanes.picker.noneSubtitleChannel', {
                defaultValue: 'The post appears on the channel’s main tab',
              })
            : t('lanes.picker.noneSubtitle', {
                defaultValue: 'The post appears on your main profile tab',
              }),
        )
        .trailing(
          Embed(
            selectedLaneId === null
              ? toElement(
                  RawText(t('lanes.picker.current', { defaultValue: 'Current' }))
                    .foreground('primary')
                    .font('sm')
                    .weight('semibold'),
                )
              : undefined,
          ),
        ),
      Embed(
        isLoading ? (
          <ListSkeleton />
        ) : (
          <FlatList
            data={lanes}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <EmptyState
                icon={RiNodeTree}
                subtitle={t('lanes.picker.empty', {
                  defaultValue:
                    'Lanes let you keep separate tracks of your posts and decide which ones reach your profile.',
                })}
              />
            }
          />
        ),
      ),
      /* `/lanes` manages the AUTHOR's lanes, which are not the ones listed while
            publishing as another account. A channel account's lanes have no
            management screen of their own yet, so the way out is omitted rather
            than pointed somewhere that would edit the wrong publisher's lanes. */ publishAs
        ? null
        : VStack(
            LButton(LText(t('lanes.picker.manage', { defaultValue: 'Manage lanes' })))
              .style('subtle')
              .tint('neutral')
              .size('lg')
              .onPress(handleManage),
          )
            .margin('top', 'sm')
            .margin('horizontal', 'lg'),
    )
      .padding('bottom', '2xl')
      .background('background')
      .flex('1'),
  );
});

export default LanePickerSheet;
