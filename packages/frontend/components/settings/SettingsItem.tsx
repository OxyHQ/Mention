import React from 'react';
import { SettingsListItem, SettingsListGroup, SettingsListDivider } from '@oxyhq/bloom/settings-list';
import type { SettingsListItemProps, SettingsListGroupProps } from '@oxyhq/bloom/settings-list';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon, type IconName } from '@/lib/icons';

/**
 * Thin wrapper around bloom's SettingsList that adds backward compatibility:
 * - Accepts Ionicons string names for `icon` (wraps in <Icon>)
 * - Maps legacy `badgeText` and `subtitle` to bloom's `value` prop
 */

interface SettingsItemProps extends Omit<SettingsListItemProps, 'icon'> {
  icon?: IconName | React.ReactNode;
  iconColor?: string;
  subtitle?: string;
  badgeText?: string;
}

export function SettingsItem({ icon, iconColor, subtitle, badgeText, ...rest }: SettingsItemProps) {
  const { colors } = useTheme();

  const resolvedIcon = typeof icon === 'string'
    ? <Icon name={icon as IconName} size={20} color={iconColor ?? (rest.destructive ? colors.error : colors.text)} />
    : icon;

  const value = rest.value ?? badgeText ?? subtitle;

  return <SettingsListItem {...rest} icon={resolvedIcon} value={value} />;
}

// Re-export bloom components directly
export const SettingsGroup = SettingsListGroup;
export const SettingsDivider = SettingsListDivider;

// Re-export types
export type { SettingsItemProps };
export type { SettingsListGroupProps as SettingsGroupProps };
