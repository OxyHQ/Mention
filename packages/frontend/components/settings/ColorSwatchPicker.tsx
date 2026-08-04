import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { APP_COLOR_PRESETS, type AppColorName } from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';

const SELECTED_SWATCH_TRANSFORM = { transform: [{ scale: 1.1 }] } as const;

interface ColorSwatchPickerProps {
  value: AppColorName;
  onChange: (name: AppColorName) => void;
  /**
   * Exactly the presets this viewer may pick, in order. The caller owns the
   * policy — this used to take only the EXTRA ones and render them on top of
   * Bloom's full `APP_COLOR_NAMES`, which offered every gated preset to everybody
   * (that list contains them) and drew a viewer's own unlocks twice. A component
   * that appends to a list it does not control cannot express a restriction.
   */
  colors: readonly AppColorName[];
}

export function ColorSwatchPicker({ value, onChange, colors }: ColorSwatchPickerProps) {
  return (
    <View className="flex-row gap-3 flex-wrap">
      {colors.map((name) => {
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
                isSelected ? 'border-foreground' : 'border-transparent',
              )}
              // NativeWind 5 / react-native-css compiles `scale-110` to
              // `transform: scale("110%")`, which React Native rejects
              // (`Transform with key of "scale" must be a number`). Use the
              // RN-native transform array for the selected pop instead.
              style={isSelected ? SELECTED_SWATCH_TRANSFORM : undefined}
            >
              {/* A single-colour chip cannot represent the colourless preset:
                  its seed is pure black, which vanishes against a dark page — the
                  one mode where a user is most likely to be reaching for it. Show
                  what the theme actually is, both halves at once. */}
              {name === 'mono' ? (
                <View className="flex-1 flex-row">
                  <View style={{ backgroundColor: '#000000', flex: 1 }} />
                  <View style={{ backgroundColor: '#ffffff', flex: 1 }} />
                </View>
              ) : (
                <View style={{ backgroundColor: preset.hex, flex: 1 }} />
              )}
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
