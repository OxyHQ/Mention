import type React from 'react';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';

import { HStack, Icon, RawText, defineTokens, toElement } from '@oxy.so/bloom-language';
/** The undescribed pill's scrim (`bg-black/60`). */
const appColors = defineTokens({ color: { hexffffff: '#ffffff', scrim: 'rgba(0, 0, 0, 0.6)' } });

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
export const ComposeAltButton: React.FC<ComposeAltButtonProps> = ({ hasAlt, raised, onPress }) =>
  toElement(
    // The pill in the image's corner (`absolute left-2 z-[3] flex-row items-center gap-0.5 rounded px-1.5 py-0.5`),
    // above the reorder controls (`bottom-12`) when raised.
    HStack(
      hasAlt ? Icon(RiCheckLine).size('11').foreground(appColors.color.hexffffff) : null,
      RawText('ALT').foreground('white').font('11').weight('bold'),
    )
      .align('center')
      .spacing('2xs')
      .padding('horizontal', '6')
      .padding('vertical', '2xs')
      .background(hasAlt ? 'primary' : appColors.color.scrim)
      .corner('xs')
      .position({ left: 'sm', bottom: raised ? '48' : 'sm' })
      .zIndex('3')
      .hitSlop('sm')
      .role('button')
      .onPress(onPress)
      .pressFade(),
  );
