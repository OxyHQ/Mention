// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { ComponentType } from 'react';
import { Text } from '@oxy.so/bloom/typography';

// A compile-time boundary: production must not ship developer fixtures or their assets.
const Playground: ComponentType | null = __DEV__
  ? require('../../components/payments/CheckoutPlaygroundScreen').default
  : null;

export default function CheckoutPlaygroundRoute() {
  return Playground ? <Playground /> : <Text>Not available</Text>;
}
