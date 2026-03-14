import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';

const IconComponent = Ionicons as React.ComponentType<React.ComponentProps<typeof Ionicons>>;

interface SettingsItemProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor?: string;
  title: string;
  subtitle?: string;
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
  onPress,
  rightElement,
  showChevron = true,
  destructive = false,
  badgeText,
}: SettingsItemProps) {
  const { colors } = useTheme();
  const resolvedIconColor = iconColor ?? (destructive ? colors.error : colors.textSecondary);
  const titleColor = destructive ? 'text-destructive' : 'text-foreground';

  const content = (
    <View className="px-4 py-3.5 flex-row items-center justify-between">
      <View className="flex-row items-center flex-1 mr-3">
        <View className="w-7 items-center justify-center mr-3">
          <IconComponent name={icon} size={20} color={resolvedIconColor} />
        </View>
        <View className="flex-1">
          <Text className={`text-[15px] font-medium ${titleColor}`}>
            {title}
          </Text>
          {subtitle ? (
            <Text className="text-[13px] text-muted-foreground mt-0.5" numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      <View className="flex-row items-center gap-2">
        {badgeText ? (
          <Text className="text-[13px] text-muted-foreground">{badgeText}</Text>
        ) : null}
        {rightElement}
        {showChevron && onPress ? (
          <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
        ) : null}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        {content}
      </TouchableOpacity>
    );
  }

  return content;
}

interface SettingsGroupProps {
  title?: string;
  children: React.ReactNode;
}

export function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <View className="mb-6">
      {title ? (
        <Text className="text-[11px] font-semibold uppercase tracking-wider mb-2 ml-3 text-muted-foreground">
          {title}
        </Text>
      ) : null}
      <View className="rounded-xl border border-border bg-card overflow-hidden">
        {React.Children.toArray(children).filter(Boolean).map((child, index, arr) => (
          <React.Fragment key={index}>
            {child}
            {index < arr.length - 1 ? <View className="h-px mx-4 bg-border" /> : null}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}
