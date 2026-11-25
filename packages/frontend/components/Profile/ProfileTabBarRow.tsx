import type React from 'react';
import { Embed, VStack, toElement } from '@oxy.so/bloom-language';

/**
 * Opaque surface for the profile's scrollable Bloom tab bar, its bottom hairline
 * as `border-b border-border` drew it.
 */
export function ProfileTabBarRow({ children }: { children: React.ReactNode }) {
  return toElement(
    VStack(Embed(children)).background('surfaceFill').border('border', 'thin', 'bottom'),
  );
}
