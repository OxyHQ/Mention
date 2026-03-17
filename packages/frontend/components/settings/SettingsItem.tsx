import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon, type IconName } from '@/lib/icons';

interface SettingsItemProps {
  icon?: IconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  description?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
  showChevron?: boolean;
  destructive?: boolean;
  badgeText?: string;
}

export function SettingsItem({
  icon,
  iconColor,
  title,
  subtitle,
  description,
  onPress,
  rightElement,
  showChevron = true,
  destructive = false,
  badgeText,
}: SettingsItemProps) {
  const { colors } = useTheme();
  const resolvedIconColor = iconColor ?? (destructive ? colors.error : colors.text);
  const titleColor = destructive ? 'text-destructive' : 'text-foreground';

  const content = (
    <View className="px-4 py-3 flex-row items-center gap-3" style={{ minHeight: 48 }}>
      {icon ? (
        <View className="w-6 items-center justify-center">
          <Icon name={icon} size={22} color={resolvedIconColor} />
        </View>
      ) : null}
      {description ? (
        <View className="flex-1">
          <Text className={`text-[16px] ${titleColor}`} style={{ lineHeight: 22 }}>
            {title}
          </Text>
          <Text className="text-[13px] text-muted-foreground mt-0.5" style={{ lineHeight: 18 }}>
            {description}
          </Text>
        </View>
      ) : (
        <Text className={`text-[16px] flex-1 ${titleColor}`} style={{ lineHeight: 22 }}>
          {title}
        </Text>
      )}
      {subtitle ? (
        <Text className="text-[14px] text-muted-foreground" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      {badgeText ? (
        <Text className="text-[14px] text-muted-foreground">{badgeText}</Text>
      ) : null}
      {rightElement}
      {showChevron && onPress ? (
        <Icon name="chevron-forward" size={18} color={colors.textTertiary} />
      ) : null}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        android_ripple={{ color: colors.border }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        {content}
      </Pressable>
    );
  }

  return content;
}

export function SettingsDivider() {
  return <View className="h-px mx-5 bg-border" />;
}

interface SettingsGroupProps {
  title?: string;
  children: React.ReactNode;
}

export function SettingsGroup({ title, children }: SettingsGroupProps) {
  const filteredChildren = React.Children.toArray(children).filter(Boolean);
  return (
    <View className="mb-6">
      {title ? (
        <View className="px-5 pt-2 pb-2">
          <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </Text>
        </View>
      ) : null}
      <View className="mx-4 rounded-xl border border-border bg-card overflow-hidden">
        {filteredChildren.map((child, index) => (
          <React.Fragment key={index}>
            {child}
            {index < filteredChildren.length - 1 ? <View className="h-px mx-4 bg-border" /> : null}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}
