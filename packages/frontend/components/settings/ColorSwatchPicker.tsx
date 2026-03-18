import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { APP_COLOR_PRESETS, APP_COLOR_NAMES, type AppColorName } from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';

interface ColorSwatchPickerProps {
  value: AppColorName;
  onChange: (name: AppColorName) => void;
}

export function ColorSwatchPicker({ value, onChange }: ColorSwatchPickerProps) {
  return (
    <View className="flex-row gap-3 flex-wrap">
      {APP_COLOR_NAMES.map((name) => {
        const preset = APP_COLOR_PRESETS[name];
        const isSelected = value === name;
        return (
          <Pressable
            key={name}
            onPress={() => onChange(name)}
            className="items-center gap-1"
          >
            <View
              className={cn(
                'w-9 h-9 rounded-full border-2 overflow-hidden',
                isSelected ? 'border-foreground scale-110' : 'border-transparent',
              )}
            >
              <View style={{ backgroundColor: preset.hex, flex: 1 }} />
            </View>
            <Text
              className={cn(
                'text-[10px] capitalize',
                isSelected ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
            >
              {name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
