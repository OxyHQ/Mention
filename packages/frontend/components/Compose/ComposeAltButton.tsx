import { tokens } from '@oxy.so/bloom/styles';
import type React from 'react';
import { TouchableOpacity, type ViewStyle } from 'react-native';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';

import { Icon, RawText, defineTokens, toElement } from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { hexffffff: '#ffffff' } });

interface ComposeAltButtonProps {
  /** Whether an alt description has already been entered for this image. */
  hasAlt: boolean;
  /**
   * Lift the pill above the bottom reorder controls, which occupy the bottom
   * corners whenever more than one attachment is present.
   */
  raised?: boolean;
  onPress: () => void;
}

/**
 * Bluesky-style "ALT" pill overlaid on a composer image thumbnail. Tapping it
 * opens the alt-text input sheet. Renders a filled (primary) state once the
 * user has described the image.
 */
export const ComposeAltButton: React.FC<ComposeAltButtonProps> = ({ hasAlt, raised, onPress }) => {
  const colorTokens = useColorTokens();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        PILL,
        {
          bottom: raised ? RAISED_BOTTOM : tokens.space.sm,
          backgroundColor: hasAlt ? colorTokens.primary : SCRIM,
        },
      ]}
      hitSlop={tokens.hitSlop.sm}
      accessibilityRole="button"
    >
      {hasAlt
        ? toElement(Icon(RiCheckLine).size('11').foreground(appColors.color.hexffffff))
        : null}
      {toElement(RawText('ALT').foreground('white').font('11').weight('bold'))}
    </TouchableOpacity>
  );
};

/** Tailwind's 1.5 step, off Bloom's space scale. */
const SPACE_6 = 6;
/** Above the reorder controls (`bottom-12`). */
const RAISED_BOTTOM = 48;
/** The undescribed pill's scrim (`bg-black/60`). */
const SCRIM = 'rgba(0, 0, 0, 0.6)';
/** The pill in the image's corner (`absolute left-2 z-[3] flex-row items-center gap-0.5 rounded px-1.5 py-0.5`). */
const PILL = {
  position: 'absolute',
  left: tokens.space.sm,
  zIndex: 3,
  flexDirection: 'row',
  alignItems: 'center',
  gap: tokens.space._2xs,
  borderRadius: tokens.borderRadius.xs,
  paddingHorizontal: SPACE_6,
  paddingVertical: tokens.space._2xs,
} satisfies ViewStyle;
