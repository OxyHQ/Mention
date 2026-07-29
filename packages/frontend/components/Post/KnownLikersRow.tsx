import React, { memo, useMemo } from 'react';
import { Pressable, Text, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AvatarGroup } from '@oxyhq/bloom/avatar-group';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useKnownLikers } from '@/hooks/useKnownLikers';
import { displayNameOrHandle } from '@/utils/displayName';

/** Diameter of each stacked avatar, matching the profile's "Followed by" row. */
const AVATAR_SIZE = 20;

/** Names spelled out before the count takes over. */
const MAX_NAMES = 2;

/**
 * Cap on a single spelled-out name. One pathologically long display name would
 * otherwise push the rest of the sentence — including the "and N others" tail,
 * the part that carries the actual magnitude — off the row.
 *
 * Ported from bluesky-social/social-app `enforceLen` usage in commit
 * `821e1b838` ("Social proof text is truncated on mobile"), which hit exactly
 * this on narrow screens.
 */
const MAX_NAME_LENGTH = 20;

function capName(name: string): string {
  return name.length > MAX_NAME_LENGTH
    ? `${name.slice(0, MAX_NAME_LENGTH).trimEnd()}…`
    : name;
}

interface KnownLikersRowProps {
  /** Post whose likers are intersected with the viewer's follow graph. */
  postId: string;
  /** Opens the likes engagement list. */
  onPress?: () => void;
  /**
   * The shared row chrome from `PostDetailStats` — full-width top hairline plus
   * the horizontal padding its sibling rows use. Passed in rather than applied
   * by the parent because this row renders nothing most of the time, and an
   * outer wrapper would leave a stray rule behind when it does.
   */
  rowStyle?: StyleProp<ViewStyle>;
}

/**
 * Social proof on a focused post — "Liked by Ana, Luis and 12 others" with
 * overlapping avatars — for the likers the viewer follows.
 *
 * The profile analogue is `Profile/FollowedByRow`, and this deliberately mirrors
 * it: same avatar size, same one/two/many copy shape, same "render nothing
 * rather than reserve height" rule. Renders null for signed-out viewers, zero
 * known likers, and while the first fetch is in flight (all surfaced through
 * {@link useKnownLikers}), so the block never changes height mid-load.
 *
 * Layout follows bluesky-social/social-app `44b1ab08b`: the social proof gets
 * its OWN full-width row rather than being folded into the like counter. The
 * sentence wraps to a second line instead of clipping, so a narrow phone
 * viewport degrades by re-flowing rather than truncating mid-name.
 */
export const KnownLikersRow = memo(function KnownLikersRow({
  postId,
  onPress,
  rowStyle,
}: KnownLikersRowProps) {
  const { t } = useTranslation();
  const { likers, total, isPending } = useKnownLikers(postId);

  // One pass serves both the face pile and the sentence, so a name can never
  // disagree with the avatar it sits next to. A degraded author resolves to an
  // EMPTY handle, never a raw id — its `name.displayName` already carries the
  // neutral fallback.
  const avatarItems = useMemo(
    () =>
      likers.map((liker) => {
        const handle = getNormalizedUserHandle(liker) ?? '';
        return {
          id: liker.id,
          uri: liker.avatar,
          displayName: displayNameOrHandle(liker.name.displayName, handle),
          username: handle || undefined,
        };
      }),
    [likers],
  );

  if (total === 0 || avatarItems.length === 0 || isPending) {
    return null;
  }

  const names = avatarItems.slice(0, MAX_NAMES).map((item) => capName(item.displayName));

  let label: string;
  if (total === 1 || names.length < 2) {
    label = t('post.likedBy.one', {
      name1: names[0],
      defaultValue: 'Liked by {{name1}}',
    });
  } else if (total === 2) {
    label = t('post.likedBy.two', {
      name1: names[0],
      name2: names[1],
      defaultValue: 'Liked by {{name1}} and {{name2}}',
    });
  } else {
    label = t('post.likedBy.many', {
      name1: names[0],
      name2: names[1],
      count: total - 2,
      defaultValue: 'Liked by {{name1}}, {{name2}} and {{count}} others',
    });
  }

  return (
    <Pressable
      className="flex-row items-center gap-2 border-border"
      style={rowStyle}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <AvatarGroup
        items={avatarItems}
        size={AVATAR_SIZE}
        max={3}
        total={total}
        variant={MEDIA_VARIANT_AVATAR}
      />
      {/* Two lines, not one: on a phone the sentence does not fit beside the
          avatars, and wrapping keeps the "and N others" tail readable where
          `numberOfLines={1}` would clip it mid-name. */}
      <Text className="text-muted-foreground text-[14px] shrink" numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
});
