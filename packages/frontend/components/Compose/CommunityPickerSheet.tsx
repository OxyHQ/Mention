import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Item } from '@oxy.so/bloom/item';
import { getNormalizedUserHandle } from '@oxy.so/core';
import type { PostUser } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { EmptyState } from '@/components/common/EmptyState';
import { useJoinedCommunities } from '@/hooks/useCommunities';
import { displayNameOrHandle } from '@/utils/displayName';

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

  const current = (
    <Text className="text-primary text-[13px] font-semibold">
      {t('compose.community.current', { defaultValue: 'Current' })}
    </Text>
  );

  const renderItem = useCallback(
    ({ item }: { item: PostUser }) => {
      const handle = getNormalizedUserHandle(item) ?? '';
      return (
        <Item
          onPress={() => handleSelect(item)}
          leading={<Avatar source={item.avatar} size={36} variant={MEDIA_VARIANT_AVATAR} />}
          title={displayNameOrHandle(item.name?.displayName, handle ? `!${handle}` : '')}
          subtitle={handle ? `!${handle}` : undefined}
          trailing={item.id === selectedCommunityId ? current : undefined}
        />
      );
    },
    [current, handleSelect, selectedCommunityId],
  );

  return (
    <View className="flex-1 pb-6 bg-background">
      <PageHeader
        title={t('compose.community.title', { defaultValue: 'Post in a community' })}
        titleAlign="center"
        safeArea={false}
        leading={
          <Button
            appearance="subtle"
            tone="neutral"
            iconOnly
            leadingIcon={RiCloseLine}
            onPress={onClose}
            accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
          />
        }
      />

      <Item
        onPress={() => handleSelect(null)}
        title={t('compose.community.none', { defaultValue: 'No community' })}
        subtitle={t('compose.community.noneSubtitle', {
          defaultValue: 'The post appears on your profile, as always',
        })}
        trailing={selectedCommunityId === null ? current : undefined}
      />

      {isLoading ? (
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
      )}

      <Item
        onPress={handleManage}
        title={t('compose.community.manage', { defaultValue: 'Create or manage communities' })}
      />
    </View>
  );
});

export default CommunityPickerSheet;
