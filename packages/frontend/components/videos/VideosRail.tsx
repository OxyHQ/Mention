import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FollowButton } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/formatNumber';
import { useVideosRail } from '@/context/VideosRailContext';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const LIKE_ACTIVE_COLOR = '#FF3040';
const BOOST_ACTIVE_COLOR = '#10B981';
const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

interface RailActionProps {
  icon: IoniconName;
  count: number;
  isActive?: boolean;
  activeColor?: string;
  onPress: () => void;
  accessibilityLabel: string;
  hideCount?: boolean;
  iconColor: string;
  textColor: string;
}

const RailAction = memo<RailActionProps>(({ icon, count, isActive, activeColor, onPress, accessibilityLabel, hideCount = false, iconColor, textColor }) => {
  const tint = isActive && activeColor ? activeColor : undefined;
  return (
    <Pressable
      style={styles.action}
      onPress={onPress}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.actionCircle} className="bg-secondary">
        <Ionicons name={icon} size={22} color={tint ?? iconColor} />
      </View>
      {!hideCount && (
        <Text style={[styles.actionCount, { color: tint ?? textColor }]}>
          {formatCompactNumber(count)}
        </Text>
      )}
    </Pressable>
  );
});

RailAction.displayName = 'RailAction';

interface ArrowButtonProps {
  icon: IoniconName;
  onPress: () => void;
  disabled: boolean;
  accessibilityLabel: string;
  iconColor: string;
}

const ArrowButton = memo<ArrowButtonProps>(({ icon, onPress, disabled, accessibilityLabel, iconColor }) => (
  <Pressable
    style={[styles.arrow, disabled && styles.arrowDisabled]}
    onPress={onPress}
    disabled={disabled}
    hitSlop={HIT_SLOP}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled }}
  >
    <View style={styles.arrowCircle} className="bg-secondary">
      <Ionicons name={icon} size={22} color={iconColor} />
    </View>
  </Pressable>
));

ArrowButton.displayName = 'ArrowButton';

/**
 * Desktop-only rail shown beside the active video on /videos (>=990). Reads the
 * active-post snapshot + the screen-bound action callbacks from
 * VideosRailContext; renders nothing until the screen is mounted and an active
 * post is published.
 */
export const VideosRail = memo(function VideosRail() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { active, index, total, activePost, prev, next, onLike, onComment, onBoost, onShare } = useVideosRail();

  if (!active || !activePost) return null;

  const iconColor = theme.colors.text;
  const mutedColor = theme.colors.textSecondary;
  const showFollow = Boolean(activePost.authorId) && !activePost.authorIsViewer;

  return (
    <View style={styles.container}>
      <View style={styles.arrowsRow}>
        <ArrowButton
          icon="chevron-up"
          onPress={prev}
          disabled={index <= 0}
          accessibilityLabel={t('videos.previous')}
          iconColor={iconColor}
        />
        <ArrowButton
          icon="chevron-down"
          onPress={next}
          disabled={index >= total - 1}
          accessibilityLabel={t('videos.next')}
          iconColor={iconColor}
        />
      </View>

      {showFollow && activePost.authorId && (
        <View style={styles.followRow}>
          <FollowButton userId={activePost.authorId} size="small" />
        </View>
      )}

      <View style={styles.actions}>
        <RailAction
          icon={activePost.isLiked ? 'heart' : 'heart-outline'}
          count={activePost.likesCount}
          isActive={activePost.isLiked}
          activeColor={LIKE_ACTIVE_COLOR}
          onPress={onLike}
          accessibilityLabel={activePost.isLiked ? 'Unlike' : 'Like'}
          iconColor={iconColor}
          textColor={iconColor}
        />
        <RailAction
          icon="chatbubble-outline"
          count={activePost.commentsCount}
          onPress={onComment}
          accessibilityLabel="Comment"
          iconColor={iconColor}
          textColor={iconColor}
        />
        <RailAction
          icon={activePost.isBoosted ? 'repeat' : 'repeat-outline'}
          count={activePost.boostsCount}
          isActive={activePost.isBoosted}
          activeColor={BOOST_ACTIVE_COLOR}
          onPress={onBoost}
          accessibilityLabel={activePost.isBoosted ? 'Undo boost' : 'Boost'}
          iconColor={iconColor}
          textColor={iconColor}
        />
        <RailAction
          icon="share-outline"
          count={0}
          onPress={onShare}
          accessibilityLabel="Share"
          iconColor={iconColor}
          textColor={iconColor}
          hideCount
        />
      </View>

      <View style={styles.viewsRow}>
        <Ionicons name="eye-outline" size={18} color={mutedColor} />
        <Text style={[styles.viewsCount, { color: mutedColor }]}>
          {formatCompactNumber(activePost.viewsCount)}
        </Text>
      </View>
    </View>
  );
});

interface RailStyles {
  container: ViewStyle;
  arrowsRow: ViewStyle;
  arrow: ViewStyle;
  arrowDisabled: ViewStyle;
  arrowCircle: ViewStyle;
  followRow: ViewStyle;
  actions: ViewStyle;
  action: ViewStyle;
  actionCircle: ViewStyle;
  actionCount: TextStyle;
  viewsRow: ViewStyle;
  viewsCount: TextStyle;
}

const styles = StyleSheet.create<RailStyles>({
  container: {
    alignItems: 'flex-start',
    gap: 20,
    paddingTop: 4,
  },
  arrowsRow: {
    alignItems: 'center',
    gap: 12,
  },
  arrow: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowDisabled: {
    opacity: 0.4,
  },
  arrowCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  followRow: {
    alignItems: 'center',
  },
  actions: {
    alignItems: 'center',
    gap: 18,
  },
  action: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionCount: {
    fontSize: 13,
    fontWeight: '600',
  },
  viewsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  viewsCount: {
    fontSize: 13,
    fontWeight: '600',
  },
});
