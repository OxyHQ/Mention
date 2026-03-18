import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { PressableScale } from '@/lib/animations/PressableScale';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services';
import { router } from 'expo-router';
import { ThemedText } from './ThemedText';
import { ResponsiveAvatarStack } from './AvatarStack';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { formatCompactNumber } from '@/utils/formatNumber';

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
 * Starter pack card matching Bluesky's StarterPackCard layout:
 * - Responsive avatar stack showing member faces at top
 * - Pack name (bold, up to 2 lines)
 * - "Starter pack by @handle" or "Starter pack by you" byline (tappable)
 * - Optional description (up to 3 lines)
 * - "N users have joined!" stat (shown when useCount >= 50)
 * - Falls back to rocket icon when no member avatars available
 */
export function StarterPackCard({ pack, onPress, noDescription }: StarterPackCardProps) {
  const theme = useTheme();
  const { user } = useAuth();

  const isOwner = pack.creator?.id ? pack.creator.id === user?.id : false;

  const handleCreatorPress = useCallback(() => {
    if (pack.creator && !isOwner) {
      router.push(`/@${pack.creator.username}` as never);
    }
  }, [pack.creator, isOwner]);

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

  const hasAvatars = pack.memberAvatars && pack.memberAvatars.length > 0;

  return (
    <PressableScale
      onPress={onPress}
      className="bg-card border-border"
      style={styles.outer}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`starterpack-${pack.id}`}>
      {/* Avatar stack or icon */}
      {hasAvatars ? (
        <ResponsiveAvatarStack
          avatars={pack.memberAvatars!}
          total={pack.totalMembers ?? pack.memberCount}
          maxDisplay={8}
        />
      ) : (
        <View className="bg-primary/20" style={styles.iconBubble}>
          <Ionicons name="rocket-outline" size={22} color={theme.colors.primary} />
        </View>
      )}

      {/* Name and byline */}
      <View style={styles.titleRow}>
        <View style={styles.titleContainer}>
          <ThemedText style={styles.title} numberOfLines={2}>
            {pack.name}
          </ThemedText>
          {pack.creator && (
            <TouchableOpacity
              onPress={handleCreatorPress}
              disabled={isOwner}
              activeOpacity={0.6}
              hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}>
              <ThemedText
                className="text-muted-foreground"
                style={styles.byline}
                numberOfLines={1}>
                {isOwner
                  ? 'Starter pack by you'
                  : `Starter pack by @${pack.creator.username}`}
              </ThemedText>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Description */}
      {!noDescription && pack.description ? (
        <ThemedText
          style={styles.descriptionText}
          numberOfLines={3}>
          {pack.description}
        </ThemedText>
      ) : null}

      {/* Stats */}
      <ThemedText className="text-muted-foreground" style={styles.stats}>
        {pack.memberCount} {pack.memberCount === 1 ? 'account' : 'accounts'}
        {pack.useCount > 0
          ? ` \u00B7 Used by ${formatCompactNumber(pack.useCount)} ${pack.useCount === 1 ? 'person' : 'people'}`
          : ''}
      </ThemedText>

      {/* Joined count — only shown when >= 50, matching Bluesky */}
      {pack.useCount >= 50 && (
        <ThemedText
          className="text-muted-foreground"
          style={styles.joinedText}>
          {formatCompactNumber(pack.useCount)} users have joined!
        </ThemedText>
      )}
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
    <View style={styles.outer} className="bg-card border-border">
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
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    width: '100%',
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    overflow: 'hidden',
  },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
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
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 20,
  },
  byline: {
    fontSize: 14,
    lineHeight: 18,
  },
  descriptionText: {
    fontSize: 14,
    lineHeight: 20,
  },
  stats: {
    fontSize: 13,
    fontWeight: '500',
  },
  joinedText: {
    fontSize: 13,
    fontWeight: '600',
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
