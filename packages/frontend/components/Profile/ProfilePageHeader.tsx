import React from 'react';
import { Image, View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import UserName from '@/components/UserName';

export const PROFILE_BANNER_HEIGHT = 170;

/** Profile identity is product content; Bloom owns its scroll-revealed header. */
export function ProfilePageHeader({ profileData, actions, revealOffset }: {
  profileData: ProfileData; actions: React.ReactNode; revealOffset: number;
}) {
  const { scrollPosition } = useLayoutScroll();
  const safeBack = useSafeBack();
  return <PageHeader
    title={<UserName name={profileData.design.displayName} verified={profileData.verified} />}
    titleReveal="onScroll"
    titleRevealOffset={revealOffset}
    scrollY={scrollPosition}
    presentation="floating"
    // ContentPanel's bleed mask sits at z-30. Keep profile chrome above that
    // mask while leaving Bloom's border frame (z-120) as the outermost edge.
    style={{ zIndex: 40 }}
    onBack={safeBack}
    actions={actions}
  />;
}

export function ProfileBanner({ uri }: { uri?: string }) {
  return <View className="bg-surface" style={{ height: PROFILE_BANNER_HEIGHT, overflow: 'hidden' }}>
    {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
  </View>;
}
