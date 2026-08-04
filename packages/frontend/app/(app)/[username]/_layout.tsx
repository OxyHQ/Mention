import React from 'react';
import { useLocalSearchParams, Slot } from 'expo-router';
import NotFoundScreen from '@/components/NotFoundScreen';
import ProfileChromeFrame from '@/components/Profile/ProfileChromeFrame';

/**
 * The `[username]` segment's navigator, and — on web — the profile chrome above
 * it.
 *
 * It renders `<Slot />` — a navigator — for every profile URL, and the screen
 * files in this directory render the surfaces themselves. That split is not
 * cosmetic. A layout that swaps its navigator for a plain screen leaves the
 * segment with no navigator in the navigation state, so a client-side push into
 * one of its children has to mount one underneath a route the router already
 * resolved without it. In the web build — where every route is an async chunk,
 * so the incoming screen suspends before it can commit — that mount and the
 * `usePathname()` it feeds chase each other until React aborts the render with
 * "Maximum update depth exceeded" (minified React error #185). Tapping "Joined"
 * on a profile did exactly that; so did every other link into `/about`,
 * `/followers`, `/following`, `/who-may-know` and `/in-common`.
 *
 * The 404 below is the one branch that is not a navigator, and it is safe where
 * a pathname-keyed branch is not: `[username]` doubles as the app's catch-all
 * for unknown single-segment paths, and whether a handle is `@`-prefixed is
 * fixed for the lifetime of a route instance. It cannot appear and disappear
 * underneath a mounted child the way the pathname could.
 *
 * Every route this segment serves is FLAT — the nine tab files and
 * `lane/[laneId]` sit beside `/about`, `/followers`, `/following`,
 * `/connections`, `/in-common` and `/who-may-know`, with no group between them.
 * `ProfileChromeFrame` is what tells the two families apart, from the pathname,
 * and draws the banner and the tab strip over the tabs only — while rendering
 * the `<Slot/>` at one position in every branch. Grouping the tabs instead was
 * tried, shipped and reverted: `router.push('/@handle')` from another profile
 * created a `[username]` entry with no nested state, and its child navigator
 * settled on `about`. That file carries the trace.
 */
const UsernameLayout = () => {
    const { username } = useLocalSearchParams<{ username: string }>();

    if (typeof username !== 'string' || !username.startsWith('@')) {
        return <NotFoundScreen />;
    }

    return (
        <ProfileChromeFrame>
            <Slot />
        </ProfileChromeFrame>
    );
};

export default UsernameLayout;
