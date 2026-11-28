// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import {
  PROFILE_AVATAR_OVERLAP,
  PROFILE_BANNER_HEIGHT,
  profileTabsOffset,
} from '../ProfilePageHeader';

jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@/components/UserName', () => ({ __esModule: true, default: () => null }));

// The stats row and a tab reselect scroll here. The summary starts
// `PROFILE_AVATAR_OVERLAP` short of the banner's bottom edge, so the banner's
// height alone lands 45px below the tab strip.
test('the tab strip starts where the summary ends, not a banner height after it', () => {
  expect(PROFILE_BANNER_HEIGHT).toBe(170);
  expect(PROFILE_AVATAR_OVERLAP).toBe(45);
  expect(profileTabsOffset(0)).toBe(125);
  expect(profileTabsOffset(255)).toBe(380);
});
