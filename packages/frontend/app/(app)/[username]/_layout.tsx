import React from 'react';
import { usePathname, useLocalSearchParams, Slot } from 'expo-router';
import NotFoundScreen from '@/components/NotFoundScreen';
import ProfileScreen from '@/components/ProfileScreen';
import FederatedProfileScreen from '@/components/FederatedProfileScreen';

/**
 * Detect if a username param is a federated handle (contains @domain after the leading @).
 * E.g. "@alice@mastodon.social" → federated, "@alice" → local.
 */
function isFederatedHandle(raw: string): boolean {
    const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
    return stripped.includes('@');
}

const UsernameLayout = () => {
    const { username } = useLocalSearchParams<{ username: string }>();
    const pathname = usePathname();

    // Determine tab from the current pathname
    // pathname will be like '/@username' or '/@username/media'
    const getTabFromPathname = (): 'posts' | 'replies' | 'media' | 'videos' | 'likes' | 'reposts' | 'feeds' => {
        if (pathname?.endsWith('/media')) return 'media';
        if (pathname?.endsWith('/videos')) return 'videos';
        if (pathname?.endsWith('/replies')) return 'replies';
        if (pathname?.endsWith('/likes')) return 'likes';
        if (pathname?.endsWith('/reposts')) return 'reposts';
        if (pathname?.endsWith('/feeds')) return 'feeds';
        return 'posts'; // Default to posts
    };

    if (typeof username === 'string' && username.startsWith('@')) {
        // Federated profile: /@user@instance
        if (isFederatedHandle(username)) {
            const handle = username.slice(1); // strip leading @
            return <FederatedProfileScreen handle={handle} />;
        }

        const isFollowersRoute = pathname?.endsWith('/followers');
        const isFollowingRoute = pathname?.endsWith('/following');
        const isWhoMayKnowRoute = pathname?.endsWith('/who-may-know');
        const isAboutRoute = pathname?.endsWith('/about');

        if (isFollowersRoute || isFollowingRoute || isWhoMayKnowRoute || isAboutRoute) {
            return <Slot />;
        }

        // Remove key to prevent remounts - component should stay mounted across tab changes
        return <ProfileScreen tab={getTabFromPathname()} />;
    }

    return <NotFoundScreen />;
};

export default UsernameLayout;
