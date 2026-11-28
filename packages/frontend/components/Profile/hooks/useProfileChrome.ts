// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { type Dispatch, type SetStateAction, useState } from 'react';
import { type ProfileScroll, useProfileScroll } from './useProfileScroll';
import type { ProfileTab } from '../types';

export interface ProfileChromeOptions {
  profileId?: string;
  currentTab: ProfileTab;
  currentLaneId?: string;
}
export interface ProfileChrome extends ProfileScroll {
  contentHeight: number;
  setContentHeight: Dispatch<SetStateAction<number>>;
}

/** Profile pagination/restoration stays product-owned; Bloom owns header geometry. */
export function useProfileChrome(options: ProfileChromeOptions): ProfileChrome {
  const scroll = useProfileScroll(options);
  const [contentHeight, setContentHeight] = useState(0);
  return { ...scroll, contentHeight, setContentHeight };
}
