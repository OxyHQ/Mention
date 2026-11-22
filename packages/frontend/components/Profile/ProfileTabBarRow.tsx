import type React from 'react';
import { View, type ViewStyle } from 'react-native';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { useSurfaceFill } from '@oxy.so/bloom/styles';

/** The row's bottom hairline, as `border-b border-border` drew it (its colour is the border token). */
const TAB_BAR_ROW_STYLE: ViewStyle = { borderBottomWidth: 1 };

/** Opaque surface for the profile's scrollable Bloom tab bar. */
export function ProfileTabBarRow({ children }: { children: React.ReactNode }) {
  const surfaceFill = useSurfaceFill();
  const colorTokens = useColorTokens();
  return (
    <View
      style={[TAB_BAR_ROW_STYLE, { borderColor: colorTokens.border, backgroundColor: surfaceFill }]}
    >
      {children}
    </View>
  );
}
