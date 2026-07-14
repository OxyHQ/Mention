import React, { type ReactNode } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { FollowButton } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { ThemedText } from './ThemedText';
import { RemoteActorBadge } from '@/components/Fediverse/FediverseBadge';
import { AgentIcon } from '@/assets/icons/agent-icon';
import { AutomatedIcon } from '@/assets/icons/automated-icon';
import { displayNameOrHandle } from '@/utils/displayName';
import { getUserPlaceholderColor } from '@/utils/userPlaceholderColor';
import { cn } from '@/lib/utils';

/**
 * ProfileCard — THE user row.
 *
 * One flat, full-width, feed-consistent row (bottom hairline, no radius) shared
 * by every surface that lists users: search, followers/following, who-to-follow,
 * suggestions, starter-pack and list members, likes/boosts, pokes. Surfaces
 * differ only in the DATA they map into {@link ProfileCardData} and in the
 * trailing control they hand to `accessory` — never in the row's own markup.
 *
 * The trailing controls (follow button, accessory) are SIBLINGS of the pressable
 * region, not descendants: on web Bloom's `Button` is a real `<button>` whose
 * click would otherwise bubble into an enclosing pressable and navigate away.
 */

export interface ProfileCardData {
  id: string;
  /** Local username, no instance suffix. */
  username?: string;
  /** Already-qualified handle (`user@domain`), for surfaces that only carry one. */
  handle?: string;
  name?: {
    displayName?: string;
  };
  avatar?: string | null;
  /** The user's chosen profile color, used as the avatar placeholder tint. */
  color?: string | null;
  verified?: boolean;
  description?: string;
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  instance?: string;
  federation?: {
    domain?: string;
  };
}

interface ProfileCardProps {
  profile: ProfileCardData;
  /** Overrides the default push to `/@handle`. */
  onPress?: () => void;
  /**
   * Renders the canonical follow button. It resolves its own state from the
   * shared follow store and renders NOTHING for the viewer's own row or while
   * the viewer cannot call private APIs, so callers never need those guards.
   */
  showFollowButton?: boolean;
  /**
   * Called when the viewer follows or unfollows from this row's follow button.
   * The button owns the follow state (and the surfaces that show it own nothing),
   * so this is the only way a caller can learn the row was acted on — used by the
   * feed recommendation bands to report the follow.
   */
  onFollowChange?: (isFollowing: boolean) => void;
  /** Extra muted line under the handle (e.g. a poke's relative time). */
  meta?: ReactNode;
  /** Trailing control rendered after the follow button (e.g. dismiss, poke). */
  accessory?: ReactNode;
  /** Bottom hairline. Off for the last row inside an already-bordered container. */
  showDivider?: boolean;
}

export function ProfileCard({
  profile,
  onPress,
  showFollowButton = false,
  onFollowChange,
  meta,
  accessory,
  showDivider = true,
}: ProfileCardProps) {
  const router = useRouter();
  const { t } = useTranslation();

  // A federated profile's canonical handle carries its instance (`user@domain`),
  // so the row never needs a separate "globe + instance" line. An unresolved
  // author has no handle at all — it must never fall back to the raw id, so a
  // profile with neither name nor handle degrades to "Unknown user" and is not
  // pressable (no `/@<id>` links).
  const handle = getNormalizedUserHandle(profile) ?? '';
  const displayName = profile.name?.displayName?.trim();
  const hasName = Boolean(displayName);
  // A real display name is the bold primary with the muted @handle below; with no
  // display name the @handle becomes the bold primary, shown ONCE.
  const showHandleLine = hasName && handle.length > 0;
  const canPress = Boolean(onPress) || handle.length > 0;
  const primaryLabel = displayNameOrHandle(
    displayName,
    handle ? `@${handle}` : t('user.unknown', { defaultValue: 'Unknown user' }),
  );

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else if (handle) {
      router.push(`/@${handle}`);
    }
  };

  const federatedBadge = profile.isFederated ? <RemoteActorBadge size={13} /> : null;

  return (
    <View
      className={cn(
        'w-full flex-row items-center gap-3 px-3 py-3',
        showDivider && 'border-b border-border',
      )}>
      <TouchableOpacity
        className="flex-1 flex-row items-start gap-3"
        onPress={handlePress}
        disabled={!canPress}
        activeOpacity={0.7}
        accessibilityRole="button">
        <Avatar
          source={profile.avatar || undefined}
          size={40}
          variant="thumb"
          verified={profile.verified}
          placeholderColor={getUserPlaceholderColor(profile)}
        />
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-1">
            <ThemedText
              className="shrink text-base font-semibold leading-5"
              numberOfLines={1}>
              {primaryLabel}
            </ThemedText>
            {/* The fediverse marker always sits next to the line carrying the
                handle — which is the primary line when there is no display name. */}
            {!showHandleLine && federatedBadge}
            {profile.isAgent && <AgentIcon size={14} className="text-muted-foreground" />}
            {profile.isAutomated && <AutomatedIcon size={14} className="text-muted-foreground" />}
          </View>
          {showHandleLine && (
            <View className="flex-row items-center gap-1">
              <ThemedText
                className="shrink text-sm leading-[18px] text-muted-foreground"
                numberOfLines={1}>
                @{handle}
              </ThemedText>
              {federatedBadge}
            </View>
          )}
          {meta ? (
            <ThemedText
              className="text-sm leading-[18px] text-muted-foreground"
              numberOfLines={1}>
              {meta}
            </ThemedText>
          ) : null}
          {profile.description ? (
            <ThemedText
              className="text-sm leading-5 text-muted-foreground"
              numberOfLines={2}>
              {profile.description}
            </ThemedText>
          ) : null}
        </View>
      </TouchableOpacity>
      {showFollowButton && (
        <FollowButton userId={profile.id} size="small" onFollowChange={onFollowChange} />
      )}
      {accessory}
    </View>
  );
}

interface ProfileCardSkeletonProps {
  /** Reserve the follow-button pill, matching the row this stands in for. */
  showFollowButton?: boolean;
  showDivider?: boolean;
}

/**
 * The loading placeholder for {@link ProfileCard}. It mirrors the row's geometry
 * exactly (same padding, hairline, 40px avatar, two text lines, follow pill), so
 * a list never shifts when the real rows land.
 *
 * Bloom's skeleton primitives take `style` (not `className`), so the shimmer
 * geometry stays as plain style objects while the row chrome stays NativeWind.
 */
export function ProfileCardSkeleton({
  showFollowButton = false,
  showDivider = true,
}: ProfileCardSkeletonProps) {
  return (
    <View
      className={cn(
        'w-full flex-row items-center gap-3 px-3 py-3',
        showDivider && 'border-b border-border',
      )}>
      <Skeleton.Circle size={40} />
      <Skeleton.Col style={{ flex: 1, gap: 6 }}>
        <Skeleton.Text style={{ width: 140, fontSize: 16, lineHeight: 20 }} />
        <Skeleton.Text style={{ width: 100, fontSize: 14, lineHeight: 18 }} />
      </Skeleton.Col>
      {showFollowButton && <Skeleton.Pill size={32} style={{ width: 80 }} />}
    </View>
  );
}

interface ProfileCardSkeletonListProps extends ProfileCardSkeletonProps {
  /** How many placeholder rows to render. */
  count: number;
}

/** `count` {@link ProfileCardSkeleton} rows — the loading state of a user list. */
export function ProfileCardSkeletonList({
  count,
  showFollowButton = false,
  showDivider = true,
}: ProfileCardSkeletonListProps) {
  return (
    <View className="w-full">
      {Array.from({ length: count }, (_, index) => (
        <ProfileCardSkeleton
          key={index}
          showFollowButton={showFollowButton}
          // The last row's hairline would double the container's own border.
          showDivider={showDivider && index < count - 1}
        />
      ))}
    </View>
  );
}
