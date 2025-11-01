import React from 'react';
import { usePathname, useLocalSearchParams } from 'expo-router';
import NotFoundScreen from '@/components/NotFoundScreen';
import ProfileScreen from '@/components/ProfileScreen';

const UsernameLayout = () => {
    const { username } = useLocalSearchParams<{ username: string }>();
    const pathname = usePathname();
    
    // Determine tab from the current pathname
    // pathname will be like '/@username' or '/@username/media'
    const getTabFromPathname = (): 'posts' | 'replies' | 'media' | 'likes' | 'reposts' => {
        if (pathname?.endsWith('/media')) return 'media';
        if (pathname?.endsWith('/replies')) return 'replies';
        if (pathname?.endsWith('/likes')) return 'likes';
        if (pathname?.endsWith('/reposts')) return 'reposts';
        return 'posts'; // Default to posts
    };

    if (typeof username === 'string' && username.startsWith('@')) {
        // Use username as key to keep component mounted across tab changes
        const cleanUsername = username.slice(1);
        return <ProfileScreen key={cleanUsername} tab={getTabFromPathname()} />;
    }

    return <NotFoundScreen />;
};

export default UsernameLayout;

