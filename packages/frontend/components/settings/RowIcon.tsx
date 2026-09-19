import React from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';

/**
 * Any icon component a Bloom part can be handed — width, height, fill.
 *
 * This used to be Mention's own `ComponentType<Props>`, the twenty-sixth
 * spelling of a shape Bloom now exports once as `BloomIconComponent`. The name
 * stays because eight files import it; the definition does not.
 */
export type BloomIcon = BloomIconComponent;

interface RowIconProps {
  icon: BloomIcon;
  destructive?: boolean;
}

/**
 * Bloom's `md` icon rung, the settings row slot. Written as a number rather than
 * `size="md"` because `size` is on the full Bloom icon surface and nothing else
 * here needs it: asking for width/height/fill is what makes the `icon` prop
 * accept any `BloomIconComponent` instead of only a real `Ri*` glyph. Bloom
 * resolves `size="md"` to this same 20, so nothing moves.
 */
const ROW_ICON_SIZE = 20;

/**
 * A settings-list leading icon. Bloom icons take colour on `fill` and do not
 * inherit it, and `SettingsListItem` does not tint its `icon` slot — so the one
 * thing this adds is the row's secondary (or destructive) colour at the slot's
 * 20px size.
 */
export const RowIcon: React.FC<RowIconProps> = ({ icon: Icon, destructive }) => {
  const { colors } = useTheme();
  return (
    <Icon
      width={ROW_ICON_SIZE}
      height={ROW_ICON_SIZE}
      fill={destructive ? colors.error : colors.textSecondary}
    />
  );
};
