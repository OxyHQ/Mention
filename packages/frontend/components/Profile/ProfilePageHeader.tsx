import type React from 'react';
import type { ProfileData } from '@/hooks/useProfileData';
import UserName from '@/components/UserName';
import { Embed, Header, toElement } from '@oxy.so/bloom-language';

/** The banner band's height. */
export const PROFILE_BANNER_HEIGHT = 170;
/** How far the summary rises into the banner: half the 90px avatar. */
export const PROFILE_AVATAR_OVERLAP = 45;
/** The ring that cuts the avatar out of the banner, as thick as X draws it. */
export const PROFILE_AVATAR_RING = 4;

/**
 * Where the tab strip starts on a profile with a banner: the summary begins
 * `PROFILE_AVATAR_OVERLAP` short of the banner's bottom edge.
 */
export function profileTabsOffset(summaryHeight: number): number {
  return PROFILE_BANNER_HEIGHT - PROFILE_AVATAR_OVERLAP + summaryHeight;
}

/** Profile identity is product content; Bloom owns its scroll-revealed header. */
export function ProfilePageHeader({
  profileData,
  actions,
  showBack = true,
}: {
  profileData: ProfileData;
  actions: React.ReactNode;
  overMedia?: boolean;
  /**
   * `false` on a root tab: a root tab has nowhere to go back to, so its header
   * draws no Back.
   */
  showBack?: boolean;
}) {
  return toElement(
    Header(UserName({ name: profileData.design.displayName, verified: profileData.verified }))
      .titleReveal('onDock')
      .presentation('floating')
      .testID('profile-page-header')
      // Bloom's own back on a pushed screen (`undefined`), none on a root tab (`null`).
      .onBack(showBack ? undefined : null)
      .toolbar(Embed(actions))
      .inPage(),
  );
}
