import React from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon, type IconName } from '@/lib/icons';

/**
 * Thin wrapper around bloom's SettingsList that adds backward compatibility:
 * - Accepts Ionicons string names for `icon` (wraps in <Icon>)
 * - Maps legacy `badgeText` and `subtitle` to bloom's `value` prop
 */

export interface SettingsListItemProps {
  title: string;
  onPress?: () => void;
  icon?: React.ReactNode;
  value?: string | React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  testID?: string;
}

export interface SettingsListGroupProps {
  title?: string;
  children: React.ReactNode;
}

interface SettingsItemProps extends Omit<SettingsListItemProps, 'icon'> {
  icon?: IconName | React.ReactNode;
  iconColor?: string;
  subtitle?: string;
  badgeText?: string;
  showChevron?: boolean;
}

export function SettingsItem({ icon, iconColor, subtitle, badgeText, ...rest }: SettingsItemProps) {
  const { colors } = useTheme();

  const resolvedIcon = typeof icon === 'string'
    ? <Icon name={icon as IconName} size={20} color={iconColor ?? (rest.destructive ? colors.error : colors.text)} />
    : icon;

  const value = rest.value ?? badgeText ?? subtitle;

  return (
    <Pressable
      onPress={rest.onPress}
      disabled={rest.disabled}
      testID={rest.testID}
      style={({ pressed }) => [
        styles.item,
        { opacity: rest.disabled ? 0.5 : 1 },
        pressed ? { backgroundColor: colors.surfaceVariant } : null,
      ]}
    >
      {resolvedIcon ? <View style={styles.icon}>{resolvedIcon}</View> : null}
      <View style={styles.content}>
        <Text style={[styles.title, { color: rest.destructive ? colors.error : colors.text }]}>
          {rest.title}
        </Text>
        {value ? (
          <Text style={[styles.value, { color: colors.textSecondary }]} numberOfLines={1}>
            {typeof value === 'string' ? value : value}
          </Text>
        ) : null}
      </View>
      {rest.showChevron !== false && rest.onPress ? (
        <Icon name="chevron-forward" size={18} color={colors.textSecondary} />
      ) : null}
    </Pressable>
  );
}

// Re-export bloom components directly
export function SettingsGroup({ title, children }: SettingsListGroupProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.group}>
      {title ? (
        <Text style={[styles.groupTitle, { color: colors.textSecondary }]}>{title}</Text>
      ) : null}
      <View style={[styles.groupBody, { borderColor: colors.border }]}>{children}</View>
    </View>
  );
}

export function SettingsDivider() {
  const { colors } = useTheme();
  return <View style={[styles.divider, { backgroundColor: colors.border }]} />;
}

// Re-export types
export type { SettingsItemProps };
export type { SettingsListGroupProps as SettingsGroupProps };

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  icon: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
    minHeight: 24,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  value: {
    marginTop: 2,
    fontSize: 14,
  },
  group: {
    marginHorizontal: 12,
    marginTop: 16,
  },
  groupTitle: {
    fontSize: 13,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontWeight: '600',
  },
  groupBody: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    overflow: 'hidden',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
  },
});
