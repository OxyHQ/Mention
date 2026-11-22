import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback } from 'react';
import { FlatList } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { getNormalizedUserHandle } from '@oxy.so/core';
import type { PostUser } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { EmptyState } from '@/components/common/EmptyState';
import { useJoinedCommunities } from '@/hooks/useCommunities';
import { displayNameOrHandle } from '@/utils/displayName';

import {
  Avatar as LAvatar,
  Button as LButton,
  Embed,
  Header,
  Icon,
  RawText,
  Row,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface CommunityPickerSheetProps {
  /** The community the post is written in, or `null` for none. */
  selectedCommunityId: string | null;
  /** `null` posts in no community — on the author's profile, as always. */
  onSelect: (community: PostUser | null) => void;
  onClose: () => void;
}

const keyExtractor = (community: PostUser) => community.id;

/**
 * Picks the community a post is written IN — one the author joined, hosted here
 * or remote (Lemmy, PieFed, Mbin). The post stays the author's: it goes out under their name,
 * and the community relays it to its members. Which communities may take it is
 * the server's call (`resolveNativePostCommunity`); this only offers the joined
 * ones, and the way to find more.
 */
const CommunityPickerSheet = memo(function CommunityPickerSheet({
  selectedCommunityId,
  onSelect,
  onClose,
}: CommunityPickerSheetProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const { data: communities = [], isLoading } = useJoinedCommunities();

  const handleSelect = useCallback(
    (community: PostUser | null) => {
      onSelect(community);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleManage = useCallback(() => {
    onClose();
    router.push('/communities');
  }, [onClose, router]);

  const current = toElement(
    RawText(t('compose.community.current', { defaultValue: 'Current' }))
      .foreground('primary')
      .font('sm')
      .weight('semibold'),
  );

  const renderItem = useCallback(
    ({ item }: { item: PostUser }) => {
      const handle = getNormalizedUserHandle(item) ?? '';
      return toElement(
        Row(displayNameOrHandle(item.name?.displayName, handle ? `!${handle}` : ''))
          .onPress(() => handleSelect(item))
          .leadingView(LAvatar(item.avatar, { variant: MEDIA_VARIANT_AVATAR }).size('lg'))
          .subtitle(handle ? `!${handle}` : undefined)
          .trailing(Embed(item.id === selectedCommunityId ? current : undefined)),
      );
    },
    [current, handleSelect, selectedCommunityId],
  );

  return toElement(
    VStack(
      Header(t('compose.community.title', { defaultValue: 'Post in a community' }))
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
      Row(t('compose.community.none', { defaultValue: 'No community' }))
        .onPress(() => handleSelect(null))
        .subtitle(
          t('compose.community.noneSubtitle', {
            defaultValue: 'The post appears on your profile, as always',
          }),
        )
        .trailing(Embed(selectedCommunityId === null ? current : undefined)),
      Embed(
        isLoading ? (
          <ListSkeleton />
        ) : (
          <FlatList
            data={communities}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <EmptyState
                icon={RiGroupLine}
                subtitle={t('compose.community.empty', {
                  defaultValue: 'Join a community to post in it.',
                })}
              />
            }
          />
        ),
      ),
      Row(t('compose.community.manage', { defaultValue: 'Create or manage communities' })).onPress(
        handleManage,
      ),
    )
      .padding('bottom', '2xl')
      .background('background')
      .flex('1'),
  );
});

export default CommunityPickerSheet;
