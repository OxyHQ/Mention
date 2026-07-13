import React from 'react';
import { View, Text } from 'react-native';

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
        className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 bg-primary border-background"
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
      />
    );
  }

  const label = count > MAX_DISPLAY_COUNT ? `${MAX_DISPLAY_COUNT}+` : String(count);

  return (
    <View
      className="absolute -top-1 -right-1.5 h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 px-[5px] bg-primary border-background"
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Text className="text-primary-foreground text-[11px] font-bold leading-[14px]" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
};

export const UnreadBadge = React.memo(UnreadBadgeComponent);

export default UnreadBadge;
