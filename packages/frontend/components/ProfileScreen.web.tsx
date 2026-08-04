import React from 'react';
import { Redirect } from 'expo-router';
import { useAuth } from '@oxyhq/services/ui/client';

import {
    ProfileTabs,
    isProfilePrivate,
    useProfileAccount,
    viewerOwnsProfile,
    type ProfileScreenProps,
} from './Profile';

/**
 * ONE PERSON's profile TAB, at `/@<handle>` and its siblings — the WEB half.
 *
 * On web this component is the tab's CONTENT and nothing else. The banner, the
 * identity summary, the action cluster and the tab strip are rendered by the
 * `(tabs)` layout above it (`Profile/ProfileTabsChrome.web.tsx`), so that
 * switching tabs swaps only this — the chrome is never unmounted, the strip's
 * underline animates across instead of blanking, and Back returns to the tab the
 * reader came from. `ProfileScreen.tsx` is the native half, where the whole page
 * is still one screen; the seam between them is documented in
 * `Profile/ProfileTabsChrome.tsx`.
 *
 * The canonical-URL redirect stays HERE rather than moving up with the chrome.
 * A layout must render its navigator unconditionally — a layout that swaps one
 * for a plain screen (or for a `<Redirect/>`, which renders null) leaves the
 * segment with no navigator in the navigation state, and on web, where every
 * route is an async chunk, the remount that follows chases `usePathname()` until
 * React aborts the render. `[username]/_layout.tsx` carries the full account.
 * A screen has no such constraint.
 */
const ProfileScreen: React.FC<ProfileScreenProps> = ({ tab = 'posts', laneId }) => {
    const { isFederated, profileData, canonicalHref } = useProfileAccount('person');
    const { user: currentUser } = useAuth();

    if (canonicalHref) {
        return <Redirect href={canonicalHref} />;
    }

    const isOwnProfile = viewerOwnsProfile(profileData, currentUser?.id, isFederated);

    return (
        <ProfileTabs
            tab={tab}
            laneId={laneId}
            profileId={profileData?.id}
            isPrivate={isProfilePrivate(profileData)}
            isOwnProfile={isOwnProfile}
            isFederated={isFederated}
            actorUri={profileData?.actorUri}
        />
    );
};

export default ProfileScreen;
