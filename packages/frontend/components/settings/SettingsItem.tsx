import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon, type IconName } from '@/lib/icons';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';

interface SettingsItemProps {
  icon?: IconName | React.ReactNode;
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
    <View className="px-4 py-2.5 flex-row items-center gap-3" style={{ minHeight: 44 }}>
      {icon ? (
        <View className="w-5 h-5 items-center justify-center">
          {typeof icon === 'string' ? (
            <Icon name={icon as IconName} size={20} color={resolvedIconColor} />
          ) : (
            icon
          )}
        </View>
      ) : null}
      {description ? (
        <View className="flex-1">
          <Text className={`text-[15px] font-medium ${titleColor}`} style={{ lineHeight: 20 }}>
            {title}
          </Text>
          <Text className="text-[13px] text-muted-foreground" style={{ lineHeight: 17 }}>
            {description}
          </Text>
        </View>
      ) : (
        <Text className={`text-[15px] font-medium flex-1 ${titleColor}`} style={{ lineHeight: 20 }}>
          {title}
        </Text>
      )}
      {subtitle ? (
        <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      {badgeText ? (
        <Text className="text-[13px] text-muted-foreground">{badgeText}</Text>
      ) : null}
      {rightElement}
      {showChevron && onPress ? (
        <ChevronRightIcon size={16} className="text-muted-foreground" />
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
  return <View className="h-px mx-4 bg-border/50" />;
}

interface SettingsGroupProps {
  title?: string;
  children: React.ReactNode;
}

export function SettingsGroup({ title, children }: SettingsGroupProps) {
  const filteredChildren = React.Children.toArray(children).filter(Boolean);
  return (
    <View className="mb-4">
      {title ? (
        <View className="px-5 pt-1 pb-1.5">
          <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </Text>
        </View>
      ) : null}
      <View className="mx-4 rounded-2xl bg-surface overflow-hidden">
        {filteredChildren.map((child, index) => (
          <React.Fragment key={index}>
            {child}
            {index < filteredChildren.length - 1 ? <View className="h-px mx-4 bg-border/30" /> : null}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}
