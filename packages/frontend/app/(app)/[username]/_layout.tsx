import React from 'react';
import { useLocalSearchParams, Slot } from 'expo-router';
import NotFoundScreen from '@/components/NotFoundScreen';

/**
 * The `[username]` segment's navigator.
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
 * This layout deliberately holds NO profile chrome. The tab routes live one
 * level down in a `(tabs)` group whose own layout owns the banner, the summary
 * and the tab strip — see `[username]/(tabs)/_layout.tsx` for why the boundary
 * is drawn there, and `components/Profile/ProfileTabsChrome.tsx` for why web and
 * native compose that group differently. The screens beside this file
 * (`/about`, `/followers`, `/following`, `/connections`, `/in-common`,
 * `/who-may-know`) are full screens with their own headers and must stay
 * outside that group.
 */
const UsernameLayout = () => {
    const { username } = useLocalSearchParams<{ username: string }>();

    if (typeof username !== 'string' || !username.startsWith('@')) {
        return <NotFoundScreen />;
    }

    return <Slot />;
};

export default UsernameLayout;
