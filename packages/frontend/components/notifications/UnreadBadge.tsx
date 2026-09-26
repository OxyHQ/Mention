import React from 'react';
import { View } from 'react-native';
import { Badge } from '@oxy.so/bloom/badge';

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

  // Bloom's counter badge draws the pill, the brand fill and the `99+` cap; the
  // wrapper only pins it to the icon's corner, rings it in the surface colour so
  // it reads as punched out of the bell, and carries the announcement (a
  // standalone `Badge` has no accessibility props of its own).
  return (
    <View
      className="absolute -top-1.5 -right-2 rounded-full p-0.5 bg-background"
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Badge content={count} max={MAX_DISPLAY_COUNT} color="primary" variant="solid" size="small" />
    </View>
  );
};

export const UnreadBadge = React.memo(UnreadBadgeComponent);

export default UnreadBadge;
