import { useState } from 'react';
import { useProfileScroll } from './useProfileScroll';
import type { ProfileTab } from '../types';

export interface ProfileChromeOptions {
  profileId?: string;
  currentTab: ProfileTab;
  currentLaneId?: string;
}
export type ProfileChrome = ReturnType<typeof useProfileChrome>;

/** Profile pagination/restoration stays product-owned; Bloom owns header geometry. */
export function useProfileChrome(options: ProfileChromeOptions) {
  const scroll = useProfileScroll(options);
  const [contentHeight, setContentHeight] = useState(0);
  return { ...scroll, contentHeight, setContentHeight };
}
