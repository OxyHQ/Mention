// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
