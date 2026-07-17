import React, { memo, useCallback } from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@oxyhq/bloom/theme';
import { useUserById } from '@/hooks/useCachedUser';
import { ProfileCard, type ProfileCardData } from '@/components/ProfileCard';

interface SuggestedUserData {
  id: string;
  username?: string;
  name: { displayName: string; first?: string; last?: string; full?: string };
  avatar?: string;
  bio?: string;
  verified?: boolean;
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  instance?: string;
}

interface SuggestedUserCardProps {
  user: SuggestedUserData;
  onDismiss: (id: string) => void;
  hideDismiss?: boolean;
}

/**
 * A suggestion row: the shared {@link ProfileCard} (identity + follow button)
 * plus the dismiss control this surface adds on top of it.
 */
export const SuggestedUserCard = memo(function SuggestedUserCard({
  user,
  onDismiss,
  hideDismiss,
}: SuggestedUserCardProps) {
  const theme = useTheme();
  const cachedUser = useUserById(user.id);

  const handleDismiss = useCallback(() => {
    onDismiss(user.id);
  }, [onDismiss, user.id]);

  const profile: ProfileCardData = {
    id: user.id,
    username: user.username || cachedUser?.username || '',
    name: user.name,
    avatar: user.avatar || cachedUser?.avatar,
    color: cachedUser?.color,
    verified: user.verified,
    description: user.bio,
    isFederated: user.isFederated,
    isAgent: user.isAgent,
    isAutomated: user.isAutomated,
    instance: user.instance,
  };

  return (
    <ProfileCard
      profile={profile}
      showFollowButton
      accessory={
        hideDismiss ? undefined : (
          <Pressable
            className="p-1"
            onPress={handleDismiss}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss suggestion"
          >
            <Ionicons name="close" size={14} color={theme.colors.textSecondary} />
          </Pressable>
        )
      }
    />
  );
});

export type { SuggestedUserData };
