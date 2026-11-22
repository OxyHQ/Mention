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

import { Embed, HStack, Text as LText, VStack, toElement } from '@oxy.so/bloom-language';

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

type FeedCardVariant = 'card' | 'row';

interface FeedCardProps {
  feed: FeedCardData;
  onPress?: () => void;
  headerRight?: React.ReactNode;
  showDescription?: boolean;
  showLikes?: boolean;
  variant?: FeedCardVariant;
}

/** Card surface (default) vs. flush full-width feed row (result lists). */
const OUTER_CLASS: Record<FeedCardVariant, string> = {
  card: 'w-full p-4 gap-2 rounded-xl bg-card',
  row: 'w-full px-3 py-3 gap-1 border-b border-border',
};

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
  const router = useRouter();
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
      className={OUTER_CLASS[variant]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`feed-${feed.id}`}
    >
      {toElement(
        HStack(
          /* Avatar */ Embed(
            <AccountAvatar
              account={feed.avatar ? undefined : feed.creator}
              source={feed.avatar || feed.creator?.avatar}
              size={36}
              variant={MEDIA_VARIANT_AVATAR}
              shape="squircle"
            />,
          ),
          /* Text content */ VStack(
            LText(feed.displayName)
              .font('14')
              .weight('semibold')
              .leading('18px')
              .foreground('foreground')
              .lines(1),
            Embed(
              feed.creator && (
                <ProfileHoverCard username={getNormalizedUserHandle(feed.creator) ?? undefined}>
                  {toElement(
                    LText('Feed by @', feed.creator.username)
                      .font('14')
                      .foreground('muted')
                      .leading('18px')
                      .lines(1),
                  )}
                </ProfileHoverCard>
              ),
            ),
          ).flex('1'),
          /* Right side: avatar cluster or custom slot */ Embed(
            avatarItems.length > 0 ? (
              <AccountAvatarGroup
                items={avatarItems}
                size={28}
                max={3}
                variant={MEDIA_VARIANT_AVATAR}
              />
            ) : headerRight ? (
              toElement(VStack(Embed(headerRight)))
            ) : null,
          ),
        )
          .align('center')
          .spacing('md'),
      )}
      {showDescription && feed.description
        ? toElement(
            LText(feed.description)
              .foreground('muted')
              .font('14')
              .leading('20px')
              .lines(variant === 'row' ? 2 : 3),
          )
        : null}
      {statsLine
        ? toElement(LText(statsLine).font('14').foreground('muted').leading('18px').lines(1))
        : null}
      {showLikes && feed.likeCount && feed.likeCount > 0
        ? toElement(
            LText(
              'Pinned by ',
              formatCompactNumber(feed.likeCount),
              ' ',
              feed.likeCount === 1 ? 'user' : 'users',
            )
              .font('14')
              .weight('semibold')
              .foreground('muted')
              .leading('18px')
              .lines(1),
          )
        : null}
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
  return (
    <View className={OUTER_CLASS.card}>
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
