import React from 'react';
import { Image, View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import UserName from '@/components/UserName';

export const PROFILE_BANNER_HEIGHT = 170;

/** Profile identity is product content; Bloom owns its scroll-revealed header. */
export function ProfilePageHeader({ profileData, actions, overMedia = true }: {
  profileData: ProfileData; actions: React.ReactNode; overMedia?: boolean;
}) {
  const safeBack = useSafeBack();
  return <PageHeader
    title={<UserName name={profileData.design.displayName} verified={profileData.verified} />}
    titleReveal="onDock"
    presentation="floating"
    placement={overMedia ? 'overlap' : 'inline'}
    testID="profile-page-header"
    onBack={safeBack}
    actions={actions}
  />;
}

export function ProfileBanner({ uri }: { uri?: string }) {
  return <View testID="profile-banner" className="bg-surface" style={{ height: PROFILE_BANNER_HEIGHT, overflow: 'hidden' }}>
    {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
  </View>;
}
