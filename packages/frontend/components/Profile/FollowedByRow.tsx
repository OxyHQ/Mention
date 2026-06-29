import React, { memo, useMemo } from 'react';
import { Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AvatarGroup, type AvatarGroupItem } from '@oxyhq/bloom/avatar-group';
import { useMutualFollowers } from '@/hooks/useMutualFollowers';

interface FollowedByRowProps {
  /** Id of the profile being viewed. */
  profileId: string;
  /** Normalized handle of the profile (drives navigation to the connections screen). */
  username: string;
}

/**
 * Twitter/Instagram-style social-proof row — "Followed by Ana, Luis and N
 * others" with overlapping avatars — for the viewer's mutual followers (people
 * the viewer follows who also follow this profile).
 *
 * Renders nothing for the viewer's own profile, signed-out viewers, zero
 * mutuals, or while the first fetch is still in flight (all surfaced through
 * {@link useMutualFollowers}). Tapping the row opens the connections screen on
 * the "In common" tab.
 */
export const FollowedByRow = memo(function FollowedByRow({ profileId, username }: FollowedByRowProps) {
  const { t } = useTranslation();
  const { mutuals, total, isPending } = useMutualFollowers(profileId);

  const avatarItems = useMemo<AvatarGroupItem[]>(
    () =>
      mutuals.map((mutual) => ({
        id: mutual.id,
        uri: mutual.avatar,
        // Fall back to the handle when a mutual has no display name.
        displayName: mutual.name.displayName?.trim() || mutual.username,
        username: mutual.username,
      })),
    [mutuals],
  );

  // No mutuals, not signed in, or own profile -> the hook returns total 0.
  // No sample yet (including the in-flight first fetch) -> nothing to show.
  if (total === 0 || mutuals.length === 0 || isPending) {
    return null;
  }

  const name1 = mutuals[0].name.displayName?.trim() || mutuals[0].username;
  const name2 = mutuals[1] ? (mutuals[1].name.displayName?.trim() || mutuals[1].username) : undefined;

  let label: string;
  if (total === 1 || !name2) {
    label = t('profile.followedBy.one', {
      name1,
      defaultValue: 'Followed by {{name1}}',
    });
  } else if (total === 2) {
    label = t('profile.followedBy.two', {
      name1,
      name2,
      defaultValue: 'Followed by {{name1}} and {{name2}}',
    });
  } else {
    label = t('profile.followedBy.many', {
      name1,
      name2,
      count: total - 2,
      defaultValue: 'Followed by {{name1}}, {{name2}} and {{count}} others',
    });
  }

  return (
    <Pressable
      className="flex-row items-center gap-2 mb-3"
      onPress={() => router.push(`/@${username}/in-common`)}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <AvatarGroup items={avatarItems} size={20} max={3} total={total} variant="thumb" />
      <Text className="text-muted-foreground text-[15px] shrink" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});
