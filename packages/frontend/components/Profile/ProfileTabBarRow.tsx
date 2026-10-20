import type React from 'react';
import { View } from 'react-native';
import { useSurfaceFill } from '@oxy.so/bloom/styles';

/** Opaque surface for the profile's scrollable Bloom tab bar. */
export function ProfileTabBarRow({ children }: { children: React.ReactNode }) {
  const surfaceFill = useSurfaceFill();
  return (
    <View className="border-b border-border" style={{ backgroundColor: surfaceFill }}>
      {children}
    </View>
  );
}
