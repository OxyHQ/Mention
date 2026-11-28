// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { BREAKPOINTS } from '@oxy.so/bloom/styles';
import { Platform, useWindowDimensions } from 'react-native';

/** Deck is a desktop web workspace; never mount its feeds on compact screens. */
export function useDeckAvailable() {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= BREAKPOINTS.lg;
}
