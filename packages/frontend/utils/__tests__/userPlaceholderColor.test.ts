// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { APP_COLOR_PRESETS } from '@oxy.so/bloom/color-presets';
import { getUserPlaceholderColor } from '../userPlaceholderColor';

it('uses the shared Bloom identity for avatars, including legacy colors', () => {
  expect(getUserPlaceholderColor({ color: 'grove' })).toBe(APP_COLOR_PRESETS.grove.hex);
  expect(getUserPlaceholderColor({ color: 'amber' })).toBe(APP_COLOR_PRESETS.yellow.hex);
  expect(getUserPlaceholderColor({ color: '#ABC' })).toBe('#aabbcc');
  expect(getUserPlaceholderColor({ color: '#123456' })).toBe('#123456');
  expect(getUserPlaceholderColor({ color: 'unknown' })).toBeUndefined();
  expect(getUserPlaceholderColor()).toBeUndefined();
});
