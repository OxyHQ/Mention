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
 * ONE PERSON's profile TAB, at `/@<handle>` and its tab siblings — the WEB half.
 *
 * On web this component is the tab's CONTENT and nothing else. The banner, the
 * identity summary, the action cluster and the tab strip are rendered by the
 * `[username]` layout above it (`Profile/ProfileChromeFrame.web.tsx`), so that
 * switching tabs swaps only this — the chrome is never unmounted, the strip's
 * underline animates across instead of blanking, and Back returns to the tab the
 * reader came from. `ProfileScreen.tsx` is the native half, where the whole page
 * is still one screen; the seam between them is documented in
 * `Profile/ProfileChromeFrame.tsx`.
 *
 * Nothing here is fetched twice. `useProfileAccount` is a React Query read under
 * the same key the layout uses, so this asks the cache the layout has already
 * filled; the two answer the same `isPrivate` / `isOwnProfile` because both go
 * through `profileViewer.ts` rather than deriving them inline.
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

    return (
        <ProfileTabs
            tab={tab}
            laneId={laneId}
            profileId={profileData?.id}
            isPrivate={isProfilePrivate(profileData)}
            isOwnProfile={viewerOwnsProfile(profileData, currentUser?.id, isFederated)}
            isFederated={isFederated}
            actorUri={profileData?.actorUri}
        />
    );
};

export default ProfileScreen;
