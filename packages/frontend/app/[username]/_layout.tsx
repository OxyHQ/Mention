import React from 'react';
import { usePathname, useLocalSearchParams, Slot } from 'expo-router';
import NotFoundScreen from '@/components/NotFoundScreen';
import ProfileScreen from '@/components/ProfileScreen';

const UsernameLayout = () => {
    const { username } = useLocalSearchParams<{ username: string }>();
    const pathname = usePathname();
    
    // Determine tab from the current pathname
    // pathname will be like '/@username' or '/@username/media'
    const getTabFromPathname = (): 'posts' | 'replies' | 'media' | 'videos' | 'likes' | 'reposts' => {
        if (pathname?.endsWith('/media')) return 'media';
        if (pathname?.endsWith('/videos')) return 'videos';
        if (pathname?.endsWith('/replies')) return 'replies';
        if (pathname?.endsWith('/likes')) return 'likes';
        if (pathname?.endsWith('/reposts')) return 'reposts';
        return 'posts'; // Default to posts
    };

    if (typeof username === 'string' && username.startsWith('@')) {
        const isFollowersRoute = pathname?.endsWith('/followers');
        const isFollowingRoute = pathname?.endsWith('/following');

        if (isFollowersRoute || isFollowingRoute) {
            return <Slot />;
        }

        // Remove key to prevent remounts - component should stay mounted across tab changes
        return <ProfileScreen tab={getTabFromPathname()} />;
    }

    return <NotFoundScreen />;
};

export default UsernameLayout;

