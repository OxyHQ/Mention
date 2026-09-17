import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';

export type NoteTipIcon = React.ComponentType<{ width?: number; height?: number; fill?: string }>;

export interface NoteTip {
  icon: NoteTipIcon;
  title?: string;
  body: string;
}

/** Icon + text rows used by the tips, "submitted" and "about" sheets. */
export function NoteTipList({ tips }: { tips: NoteTip[] }) {
  const { colors } = useTheme();
  return (
    <View className="gap-5">
      {tips.map((tip) => (
        <View key={tip.body} className="flex-row gap-3">
          <View className="pt-0.5">
            <tip.icon width={20} height={20} fill={colors.text} />
          </View>
          <View className="flex-1 gap-0.5">
            {tip.title ? <Text className="text-foreground text-[15px] font-semibold">{tip.title}</Text> : null}
            <Text className={tip.title ? 'text-muted-foreground text-[14px] leading-5' : 'text-foreground text-[15px] leading-5'}>
              {tip.body}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}
