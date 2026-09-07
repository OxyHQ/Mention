import React from 'react';
import ProfileScreen from '@/components/ProfileScreen';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';

export default function ProfileStarterPacksRoute() {
    const username = useRoutedProfileUsername();
    return <ProfileScreen username={username} tab="starter_packs" />;
}
