import React from 'react';
import { Image, Platform, View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import UserName from '@/components/UserName';

export const PROFILE_BANNER_HEIGHT = 170;

/** Profile identity is product content; Bloom owns its scroll-revealed header. */
export function ProfilePageHeader({ profileData, actions, overMedia = true, showBack = true }: {
  profileData: ProfileData; actions: React.ReactNode; overMedia?: boolean;
  /**
   * `false` on a root tab. Bloom's `PageHeader` draws Back whenever it is handed
   * an `onBack`, and a root tab has nowhere to go back to.
   */
  showBack?: boolean;
}) {
  const safeBack = useSafeBack();
  return <PageHeader
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
  />;
}

export function ProfileBanner({ uri }: { uri?: string }) {
  return <View testID="profile-banner" className="bg-surface" style={{ height: PROFILE_BANNER_HEIGHT, overflow: 'hidden' }}>
    {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
  </View>;
}
