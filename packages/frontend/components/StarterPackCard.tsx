import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { useTheme } from '@oxy.so/bloom/theme';
import { AvatarGroup, type AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useAuth } from '@oxy.so/services/ui/client';
import { router } from 'expo-router';
import { Text } from '@oxy.so/bloom/typography';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { formatCompactNumber } from '@/utils/formatNumber';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { StarterPackIcon } from '@/assets/icons/starter-pack-icon';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';

export interface StarterPackCardData {
  id: string;
  name: string;
  description?: string;
  creator?: {
    id?: string;
    username: string;
    displayName?: string;
    avatar?: string;
  };
  memberCount: number;
  useCount: number;
  /** Avatar URIs for the responsive avatar stack */
  memberAvatars?: string[];
  /** Total member count for "+N" calculation (defaults to memberCount) */
  totalMembers?: number;
}

interface StarterPackCardProps {
  pack: StarterPackCardData;
  onPress?: () => void;
  /** Hide description (compact variant for notifications) */
  noDescription?: boolean;
}

/**
 * The pack mark as an `IconCircle` glyph: the circle hands its glyph a colour
 * through `style.color` (the `primary` half of its tint pair), which this app
 * icon takes as a `color` prop.
 */
function StarterPackGlyph({ style }: { style?: StyleProp<ViewStyle & { color?: ColorValue }> }) {
  const color = StyleSheet.flatten(style)?.color;
  return <StarterPackIcon size={22} color={typeof color === 'string' ? color : undefined} />;
}

/** Max avatars shown in the compact row cluster before the "+N" overflow chip. */
const MAX_ROW_AVATARS = 6;

/**
 * Starter pack card matching Bluesky's StarterPackCard layout:
 * - Responsive avatar stack showing member faces at top
 * - Pack name (bold, up to 2 lines)
 * - "Starter pack by @handle" or "Starter pack by you" byline (tappable)
 * - Optional description (up to 3 lines)
 * - "N users have joined!" stat (shown when useCount >= 50)
 * - Falls back to the starter-pack mark when no member avatars available
 */
export function StarterPackCard({ pack, onPress, noDescription }: StarterPackCardProps) {
  const theme = useTheme();
  const { user } = useAuth();

  const isOwner = pack.creator?.id ? pack.creator.id === user?.id : false;

  // One handle for the byline's link and its hover preview.
  const creatorHandle = useMemo(
    () => getNormalizedUserHandle({ username: pack.creator?.username }) ?? undefined,
    [pack.creator?.username],
  );

  const handleCreatorPress = useCallback(() => {
    const href = profileHrefForUser({ username: pack.creator?.username });
    if (href && !isOwner) {
      router.push(href);
    }
  }, [pack.creator?.username, isOwner]);

  const accessibilityLabel = useMemo(() => {
    const parts = [pack.name];
    if (pack.creator) {
      parts.push(
        isOwner
          ? 'starter pack by you'
          : `starter pack by @${pack.creator.username}`,
      );
    }
    parts.push(
      `${pack.memberCount} ${pack.memberCount === 1 ? 'account' : 'accounts'}`,
    );
    if (pack.useCount > 0) {
      parts.push(`used by ${pack.useCount} ${pack.useCount === 1 ? 'person' : 'people'}`);
    }
    return parts.join(', ');
  }, [pack.name, pack.creator, pack.memberCount, pack.useCount, isOwner]);

  const avatarItems = useMemo<AvatarGroupItem[]>(
    () =>
      (pack.memberAvatars ?? []).map((uri, index) => ({
        id: `${pack.id}-avatar-${index}`,
        uri,
      })),
    [pack.memberAvatars, pack.id],
  );

  const hasAvatars = avatarItems.length > 0;

  return (
    <PressableScale
      onPress={onPress}
      style={styles.pressable}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`starterpack-${pack.id}`}>
      {/* The press owns the scale; Bloom's `Card` owns the surface. */}
      <Card variant="outlined" border="hairline" radius="radius-12" style={styles.outer}>
        {/* Compact group-avatar cluster, or the pack mark when no avatars exist */}
        {hasAvatars ? (
          <AvatarGroup
            items={avatarItems}
            size={32}
            variant={MEDIA_VARIANT_AVATAR}
            max={MAX_ROW_AVATARS}
            total={pack.totalMembers ?? pack.memberCount}
            ringColor={theme.colors.card}
          />
        ) : (
          <IconCircle icon={StarterPackGlyph} style={styles.iconBubble} />
        )}

        {/* Name and byline */}
        <View style={styles.titleRow}>
          <View style={styles.titleContainer}>
            <Text variant="headline-semibold" style={styles.title} numberOfLines={2}>
              {pack.name}
            </Text>
            {pack.creator && (
              // No preview of yourself — the byline reads "by you" and is not
              // even a link in that case.
              <ProfileHoverCard username={isOwner ? undefined : creatorHandle}>
                <TouchableOpacity
                  onPress={handleCreatorPress}
                  disabled={isOwner}
                  activeOpacity={0.6}
                  // Vertical only on purpose: the card behind this byline is
                  // itself pressable, so horizontal slop would take taps meant
                  // for opening the pack.
                  hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}>
                  <Text
                    variant="body-regular"
                    style={[styles.byline, { color: theme.colors.textSecondary }]}
                    numberOfLines={1}>
                    {isOwner
                      ? 'Starter pack by you'
                      : `Starter pack by @${pack.creator.username}`}
                  </Text>
                </TouchableOpacity>
              </ProfileHoverCard>
            )}
          </View>
        </View>

        {/* Description */}
        {!noDescription && pack.description ? (
          <Text variant="body-regular" numberOfLines={3}>
            {pack.description}
          </Text>
        ) : null}

        {/* Stats */}
        <Text variant="body-2-medium" style={[styles.statLine, { color: theme.colors.textSecondary }]}>
          {pack.memberCount} {pack.memberCount === 1 ? 'account' : 'accounts'}
          {pack.useCount > 0
            ? ` \u00B7 Used by ${formatCompactNumber(pack.useCount)} ${pack.useCount === 1 ? 'person' : 'people'}`
            : ''}
        </Text>

        {/* Joined count — only shown when >= 50, matching Bluesky */}
        {pack.useCount >= 50 && (
          <Text
            variant="body-2-semibold"
            style={[styles.statLine, { color: theme.colors.textSecondary }]}>
            {formatCompactNumber(pack.useCount)} users have joined!
          </Text>
        )}
      </Card>
    </PressableScale>
  );
}

/**
 * Compact notification variant — no icon, no description.
 * Matches Bluesky's StarterPackCard.Notification.
 */
export function StarterPackCardNotification({
  pack,
  onPress,
}: StarterPackCardProps) {
  return <StarterPackCard pack={pack} onPress={onPress} noDescription />;
}

/**
 * Skeleton placeholder matching StarterPackCard layout.
 */
export function StarterPackCardSkeleton() {
  return (
    <Card variant="outlined" border="hairline" radius="radius-12" style={styles.outer}>
      {/* Skeleton avatar row */}
      <View style={styles.skeletonAvatarRow}>
        {Array.from({ length: 6 }).map((_, i) => (
          <View
            key={i}
            className="bg-input"
            style={[styles.skeletonCircle, { marginLeft: i > 0 ? -8 : 0, zIndex: 6 - i }]}
          />
        ))}
      </View>
      <Skeleton.Row style={{ gap: 12 }}>
        <Skeleton.Col style={{ gap: 6 }}>
          <Skeleton.Text style={{ width: 160, fontSize: 16 }} />
          <Skeleton.Text style={{ width: 120, fontSize: 14 }} />
        </Skeleton.Col>
      </Skeleton.Row>
      <Skeleton.Text style={{ width: '70%' as unknown as number, fontSize: 14 }} />
    </Card>
  );
}

const styles = StyleSheet.create({
  pressable: {
    width: '100%',
  },
  outer: {
    width: '100%',
    padding: 16,
    gap: 10,
  },
  // The pack mark keeps its rounded-square tile; `IconCircle` supplies the
  // primary tint pair, this only its geometry.
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 10,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  titleContainer: {
    flex: 1,
    gap: 2,
  },
  title: {
    lineHeight: 20,
  },
  byline: {
    lineHeight: 18,
  },
  statLine: {
    lineHeight: 24,
  },
  // Skeleton styles
  skeletonAvatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  skeletonCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
});
