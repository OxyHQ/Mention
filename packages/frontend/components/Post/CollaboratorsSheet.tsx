import React, { useCallback } from 'react';
import { View, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import { ProfileCard } from '@/components/ProfileCard';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { PostUser } from '@mention/shared-types';

interface CollaboratorsSheetProps {
  /**
   * Owner + accepted collaborators, already hydrated on the post (`post.authors`).
   * The sheet renders them directly — there is NO fetch here, unlike the
   * likes/boosts {@link EngagementListSheet}.
   */
  authors: PostUser[];
  onClose: () => void;
}

/**
 * The collaborators of a multi-author post, as a bottom-sheet list. Surfaces each
 * author's full identity — displayName + @username (federated authors render
 * `@user@domain`) — which the compact byline (first names only) omits. Reuses
 * {@link ProfileCard} for every row and the same `getNormalizedUserHandle` →
 * `/@handle` navigation as {@link EngagementListSheet}.
 */
const CollaboratorsSheet: React.FC<CollaboratorsSheetProps> = ({ authors, onClose }) => {
  const router = useRouter();
  const { t } = useTranslation();

  const handleUserPress = useCallback((user: PostUser) => {
    onClose();
    const profileHandle = getNormalizedUserHandle(user);
    if (profileHandle) {
      router.push(`/@${profileHandle}`);
    }
  }, [onClose, router]);

  const renderUser = useCallback(({ item }: { item: PostUser }) => (
    <ProfileCard
      profile={{
        id: item.id,
        username: item.username,
        name: item.name,
        avatar: item.avatar,
        verified: item.verified,
        isFederated: item.isFederated,
        instance: item.instance,
        federation: item.federation,
      }}
      showFollowButton
      onPress={() => handleUserPress(item)}
    />
  ), [handleUserPress]);

  return (
    <View className="flex-1 bg-background">
      <Header
        options={{
          title: t('collab.collaboratorsTitle', { defaultValue: 'Collaborators' }),
          rightComponents: [
            <IconButton variant="icon"
              key="close"
              onPress={onClose}
            >
              <CloseIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <FlatList
        data={authors}
        renderItem={renderUser}
        keyExtractor={(item) => item.id}
      />
    </View>
  );
};

export default CollaboratorsSheet;
