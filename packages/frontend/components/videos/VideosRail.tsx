import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FollowButton } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/formatNumber';
import { useVideosRail } from '@/context/VideosRailContext';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

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
  const { active, index, total, activePost, prev, next } = useVideosRail();

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
  viewsRow: ViewStyle;
  viewsCount: TextStyle;
}

const styles = StyleSheet.create<RailStyles>({
  container: {
    alignItems: 'center',
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
