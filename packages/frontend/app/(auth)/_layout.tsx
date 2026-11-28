// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { Slot } from '@/lib/navigation/router';
import { View } from 'react-native';
import { BootMilestone } from '@/components/BootMilestone';

export default function AuthLayout() {
  return (
    <View className="flex-1 bg-background">
      <Slot />
      <BootMilestone name="route-mounted" />
    </View>
  );
}
