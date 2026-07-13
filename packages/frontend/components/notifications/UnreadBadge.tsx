import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/** Above this the pill collapses to "99+" so it never grows unbounded. */
const MAX_DISPLAY_COUNT = 99;

interface UnreadBadgeProps {
  /** Number of unread notifications. The badge renders nothing when <= 0. */
  count: number;
  /**
   * Collapsed presentation: render a small solid dot instead of the numbered
   * pill (used over the collapsed sidebar icon where there is no room for a
   * number).
   */
  dot?: boolean;
  /** Accessibility label announced for the badge (already localized). */
  accessibilityLabel?: string;
}

/**
 * Brand-colored unread indicator overlaid on the notifications bell (bottom bar)
 * and sidebar icon. Numbered pill by default; a small dot in `dot` mode. Renders
 * `null` when there is nothing unread so callers can mount it unconditionally.
 */
const UnreadBadgeComponent: React.FC<UnreadBadgeProps> = ({ count, dot = false, accessibilityLabel }) => {
  if (count <= 0) return null;

  if (dot) {
    return (
      <View
        className="bg-primary border-background"
        style={styles.dot}
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
      />
    );
  }

  const label = count > MAX_DISPLAY_COUNT ? `${MAX_DISPLAY_COUNT}+` : String(count);

  return (
    <View
      className="bg-primary border-background"
      style={styles.pill}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Text className="text-primary-foreground" style={styles.pillText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  dot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
});

export const UnreadBadge = React.memo(UnreadBadgeComponent);

export default UnreadBadge;
