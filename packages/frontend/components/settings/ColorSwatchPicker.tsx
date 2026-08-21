import React from 'react';
import { View, Text, Pressable } from 'react-native';
import {
  COLOR_PRESET_FAMILIES,
  COLOR_PRESET_GROUPS,
  type AppColorName,
} from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';

const SELECTED_SWATCH_TRANSFORM = { transform: [{ scale: 1.1 }] } as const;

interface ColorSwatchPickerProps {
  value: AppColorName;
  onChange: (name: AppColorName) => void;
  /**
   * Exactly the presets this viewer may pick. The caller owns the entitlement
   * policy; Bloom's registry owns their family, label and order. This used to
   * append unlocks to Bloom's full list, which offered gated presets to everyone.
   */
  colors: readonly AppColorName[];
}

export function ColorSwatchPicker({ value, onChange, colors }: ColorSwatchPickerProps) {
  const allowed = new Set(colors);
  const visibleGroups = COLOR_PRESET_FAMILIES.flatMap((family) => {
    const group = COLOR_PRESET_GROUPS[family];
    const presets = group.presets.filter(({ name }) => allowed.has(name));
    return presets.length > 0 ? [{ ...group, presets }] : [];
  });

  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Color theme" className="gap-5">
      {visibleGroups.map((group) => (
        <View key={group.name} className="gap-2.5">
          <View className="gap-0.5">
            <Text className="text-sm font-semibold text-foreground">{group.displayName}</Text>
            <Text className="text-xs text-muted-foreground">{group.description}</Text>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {group.presets.map((preset) => {
              const isSelected = value === preset.name;
              return (
                <Pressable
                  key={preset.name}
                  onPress={() => onChange(preset.name)}
                  accessibilityRole="radio"
                  accessibilityLabel={preset.displayName}
                  accessibilityState={{ selected: isSelected }}
                  aria-checked={isSelected}
                  className={cn(
                    'min-w-[132px] max-w-[180px] flex-1 flex-row items-center gap-2 rounded-xl p-2',
                    isSelected ? 'bg-muted' : 'bg-transparent',
                  )}
                >
                  <View
                    className={cn(
                      'w-9 h-9 shrink-0 rounded-full border-2 overflow-hidden',
                      isSelected ? 'border-foreground' : 'border-transparent',
                    )}
                    // NativeWind 5 / react-native-css compiles `scale-110` to
                    // `transform: scale("110%")`, which React Native rejects.
                    style={isSelected ? SELECTED_SWATCH_TRANSFORM : undefined}
                  >
                    {/* Curated recipes show identity + action. Monochrome uses
                        black + white so the chip remains visible in both modes. */}
                    {preset.variant === 'monochrome' ? (
                      <View className="flex-1 flex-row">
                        <View style={{ backgroundColor: '#000000', flex: 1 }} />
                        <View style={{ backgroundColor: '#ffffff', flex: 1 }} />
                      </View>
                    ) : preset.tertiaryHex ? (
                      <View className="flex-1 flex-row">
                        <View style={{ backgroundColor: preset.hex, flex: 1 }} />
                        <View style={{ backgroundColor: preset.tertiaryHex, flex: 1 }} />
                      </View>
                    ) : (
                      <View style={{ backgroundColor: preset.hex, flex: 1 }} />
                    )}
                  </View>
                  <Text
                    numberOfLines={2}
                    className={cn(
                      'min-w-0 flex-1 text-xs',
                      isSelected ? 'text-foreground font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {preset.displayName}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}
