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
