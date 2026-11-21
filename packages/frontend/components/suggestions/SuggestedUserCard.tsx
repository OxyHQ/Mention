import { tokens } from '@oxy.so/bloom/styles';
import { memo, useCallback } from 'react';
import { Pressable } from 'react-native';

import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { ProfileCard, type ProfileCardData } from '@/components/ProfileCard';

interface SuggestedUserData {
  id: string;
  username?: string;
  name: { displayName: string; first?: string; last?: string; full?: string };
  avatar?: string;
  color?: string;
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
  const handleDismiss = useCallback(() => {
    onDismiss(user.id);
  }, [onDismiss, user.id]);

  const profile: ProfileCardData = {
    id: user.id,
    username: user.username || '',
    name: user.name,
    avatar: user.avatar,
    color: user.color,
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
            hitSlop={tokens.hitSlop.md}
            accessibilityRole="button"
            accessibilityLabel="Dismiss suggestion"
          >
            <RiCloseLine width={14} fill={theme.colors.textSecondary} />
          </Pressable>
        )
      }
    />
  );
});

export type { SuggestedUserData };
