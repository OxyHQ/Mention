import type React from 'react';
import { Platform } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import UserName from '@/components/UserName';

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
  overMedia = true,
  showBack = true,
}: {
  profileData: ProfileData;
  actions: React.ReactNode;
  overMedia?: boolean;
  /**
   * `false` on a root tab. Bloom's `PageHeader` draws Back whenever it is handed
   * an `onBack`, and a root tab has nowhere to go back to.
   */
  showBack?: boolean;
}) {
  const safeBack = useSafeBack();
  return (
    <PageHeader
      title={<UserName name={profileData.design.displayName} verified={profileData.verified} />}
      titleReveal="onDock"
      presentation="floating"
      // Native lists paint their viewport above preceding siblings. Bloom's
      // overlay placement creates the measured native chrome layer so the header
      // remains above the banner/list; web keeps document overlap for its sticky
      // flow geometry.
      placement={overMedia ? (Platform.OS === 'web' ? 'overlap' : 'overlay') : 'inline'}
      testID="profile-page-header"
      onBack={showBack ? safeBack : undefined}
      actions={actions}
    />
  );
}
