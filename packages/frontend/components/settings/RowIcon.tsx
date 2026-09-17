import React from 'react';
import { useTheme } from '@oxy.so/bloom/theme';
import type { Props as BloomIconProps } from '@oxy.so/bloom/icons';

/** Any Bloom (Remix) icon component, e.g. `RiLockLine` from `@oxy.so/bloom/icons`. */
export type BloomIcon = React.ComponentType<BloomIconProps>;

interface RowIconProps {
  icon: BloomIcon;
  destructive?: boolean;
}

/**
 * A settings-list leading icon. Bloom icons take colour on `fill` and do not
 * inherit it, and `SettingsListItem` does not tint its `icon` slot — so the one
 * thing this adds is the row's secondary (or destructive) colour at the slot's
 * 20px size.
 */
export const RowIcon: React.FC<RowIconProps> = ({ icon: Icon, destructive }) => {
  const { colors } = useTheme();
  return <Icon size="md" fill={destructive ? colors.error : colors.textSecondary} />;
};
