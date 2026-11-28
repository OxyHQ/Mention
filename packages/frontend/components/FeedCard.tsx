import { AccountAvatarGroup } from '@/components/ui/AccountAvatarGroup';
import type { AvatarIdentitySummary } from '@mention/shared-types';
import type React from 'react';
import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { useRouter } from '@/lib/navigation/router';
import { Text } from '@oxy.so/bloom/typography';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import type { AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { formatCompactNumber } from '@/utils/formatNumber';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const useTextStyles = createTokenStyles((t) => ({
  name: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
  quiet: { fontSize: 14, lineHeight: 18, color: t.mutedForeground },
  description: { fontSize: 14, lineHeight: 20, color: t.mutedForeground },
  pinned: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: t.mutedForeground },
}));

export interface FeedCardData {
  id: string;
  uri?: string;
  displayName: string;
  description?: string;
  avatar?: string | null;
  creator?: {
    username: string;
    displayName?: string;
    avatar?: string;
    kind?: AvatarIdentitySummary['kind'];
    character?: AvatarIdentitySummary['character'];
    color?: AvatarIdentitySummary['color'];
  };
  likeCount?: number;
  memberCount?: number;
  subscriberCount?: number;
  topicCount?: number;
  memberAvatars?: string[];
  memberProfiles?: AvatarIdentitySummary[];
}

export type FeedCardVariant = 'card' | 'row';

interface FeedCardProps {
  feed: FeedCardData;
  onPress?: () => void;
  headerRight?: React.ReactNode;
  showDescription?: boolean;
  showLikes?: boolean;
  variant?: FeedCardVariant;
}

/** Card surface (default) vs. flush full-width feed row (result lists). */
const useOuterStyles = createTokenStyles((t) => ({
  card: { width: '100%', padding: 16, gap: 8, borderRadius: 12, backgroundColor: t.card },
  row: {
    width: '100%',
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 4,
    borderBottomWidth: 1,
    borderColor: t.border,
  },
}));

/**
 * Feed card matching Bluesky's FeedSourceCard layout:
 * - 36px algo avatar on the left
 * - Feed name (bold, single line)
 * - "Feed by @handle" byline (muted, single line)
 * - Optional description (muted, up to 3 lines)
 * - Optional "Pinned by N users" stat line
 * - Optional memberAvatars stack or headerRight slot on the right
 */
export function FeedCard({
  feed,
  onPress,
  headerRight,
  showDescription = true,
  showLikes = false,
  variant = 'card',
}: FeedCardProps) {
  const textStyles = useTextStyles();
  const router = useRouter();
  const outerStyles = useOuterStyles();
  const handlePress = useCallback(() => {
    if (onPress) {
      onPress();
    } else if (feed.id) {
      router.push(`/feeds/${feed.id}`);
    }
  }, [onPress, feed.id, router]);

  const statsLine = useMemo(() => {
    const parts: string[] = [];
    if (feed.topicCount && feed.topicCount > 0) {
      parts.push(`${feed.topicCount} ${feed.topicCount === 1 ? 'topic' : 'topics'}`);
    }
    if (feed.memberCount && feed.memberCount > 0) {
      parts.push(`${feed.memberCount} ${feed.memberCount === 1 ? 'profile' : 'profiles'}`);
    }
    return parts.join(' · ');
  }, [feed.topicCount, feed.memberCount]);

  const accessibilityLabel = useMemo(() => {
    const parts = [feed.displayName];
    if (feed.creator) {
      parts.push(`a feed by @${feed.creator.username}`);
    }
    if (feed.memberCount && feed.memberCount > 0) {
      parts.push(`${feed.memberCount} ${feed.memberCount === 1 ? 'profile' : 'profiles'}`);
    }
    if (showLikes && feed.likeCount && feed.likeCount > 0) {
      parts.push(`pinned by ${feed.likeCount} ${feed.likeCount === 1 ? 'user' : 'users'}`);
    }
    return parts.join(', ');
  }, [feed.displayName, feed.creator, feed.memberCount, feed.likeCount, showLikes]);

  const avatarItems: AvatarGroupItem[] = useMemo(() => {
    if (feed.memberProfiles)
      return feed.memberProfiles.map((profile) => ({
        id: profile.id,
        kind: profile.kind,
        character: profile.character,
        color: profile.color,
        uri: profile.avatar,
        displayName: profile.name?.displayName,
        username: getNormalizedUserHandle(profile) ?? undefined,
      }));
    if (!feed.memberAvatars || feed.memberAvatars.length === 0) return [];
    return feed.memberAvatars.map((uri, i) => ({
      id: `member-${i}`,
      uri,
    }));
  }, [feed.memberAvatars, feed.memberProfiles]);

  return (
    <PressableScale
      onPress={handlePress}
      style={outerStyles[variant]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`feed-${feed.id}`}
    >
      <View className="flex-row items-center gap-3">
        {/* Avatar */}
        <AccountAvatar
          account={feed.avatar ? undefined : feed.creator}
          source={feed.avatar || feed.creator?.avatar}
          size={36}
          variant={MEDIA_VARIANT_AVATAR}
          shape="squircle"
        />

        {/* Text content */}
        <View className="flex-1">
          <Text style={textStyles.name} numberOfLines={1}>
            {feed.displayName}
          </Text>
          {feed.creator && (
            <ProfileHoverCard username={getNormalizedUserHandle(feed.creator) ?? undefined}>
              <Text style={textStyles.quiet} numberOfLines={1}>
                Feed by @{feed.creator.username}
              </Text>
            </ProfileHoverCard>
          )}
        </View>

        {/* Right side: avatar cluster or custom slot */}
        {avatarItems.length > 0 ? (
          <AccountAvatarGroup
            items={avatarItems}
            size={28}
            max={3}
            variant={MEDIA_VARIANT_AVATAR}
          />
        ) : headerRight ? (
          <View>{headerRight}</View>
        ) : null}
      </View>

      {showDescription && feed.description ? (
        <Text style={textStyles.description} numberOfLines={variant === 'row' ? 2 : 3}>
          {feed.description}
        </Text>
      ) : null}

      {statsLine ? (
        <Text style={textStyles.quiet} numberOfLines={1}>
          {statsLine}
        </Text>
      ) : null}

      {showLikes && feed.likeCount && feed.likeCount > 0 ? (
        <Text style={textStyles.pinned} numberOfLines={1}>
          Pinned by {formatCompactNumber(feed.likeCount)} {feed.likeCount === 1 ? 'user' : 'users'}
        </Text>
      ) : null}
    </PressableScale>
  );
}

/**
 * Skeleton placeholder matching FeedCard layout.
 * Shows grey boxes for avatar, title, byline, and description.
 *
 * Bloom's Skeleton primitives take `style` (not `className`), so the shimmer
 * geometry stays as plain style objects here.
 */
export function FeedCardSkeleton() {
  const outerStyles = useOuterStyles();
  return (
    <View style={outerStyles.card}>
      <Skeleton.Row style={{ alignItems: 'center', gap: 12 }}>
        <Skeleton.Circle size={36} />
        <Skeleton.Col style={{ flex: 1, gap: 6 }}>
          <Skeleton.Text style={{ width: 140, fontSize: 14 }} />
          <Skeleton.Text style={{ width: 100, fontSize: 13 }} />
        </Skeleton.Col>
      </Skeleton.Row>
      <Skeleton.Box width="80%" height={14} />
    </View>
  );
}
