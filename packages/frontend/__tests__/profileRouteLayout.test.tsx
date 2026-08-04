/**
 * The `[username]` segment's layout, and the screens it used to render itself.
 *
 * The layout used to pick its output from `usePathname()`: `<Slot />` for the
 * profile sub-routes (`/about`, `/followers`, `/following`, `/who-may-know`,
 * `/in-common`) and `<ProfileScreen />` — a plain screen, not a navigator — for
 * the profile itself and its tabs. So while a profile was on screen the segment
 * had NO navigator in the navigation state, and a client-side push into one of
 * its children had to mount one underneath a route the router had already
 * resolved without it. In the web build every route is an async chunk, so the
 * incoming screen suspends before it can commit, the navigator never settles,
 * and it and `usePathname()` chase each other until React aborts the render
 * with "Maximum update depth exceeded" (minified React error #185) and the app
 * error boundary takes over. That is what tapping "Joined" on a profile did.
 *
 * The invariant that fixes it, and the one asserted here: the navigator this
 * layout renders must not depend on the pathname. The 404 branch may, because
 * it depends only on `username`, which is fixed for a route instance's whole
 * lifetime and therefore cannot appear and disappear underneath a mounted
 * child.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ProfileTab } from '@/components/Profile/types';
import UsernameLayout from '@/app/(app)/[username]/_layout';
import PostsRoute from '@/app/(app)/[username]/index';
import RepliesRoute from '@/app/(app)/[username]/replies';
import MediaRoute from '@/app/(app)/[username]/media';
import VideosRoute from '@/app/(app)/[username]/videos';
import LikesRoute from '@/app/(app)/[username]/likes';
import BoostsRoute from '@/app/(app)/[username]/boosts';
import FeedsRoute from '@/app/(app)/[username]/feeds';
import StarterPacksRoute from '@/app/(app)/[username]/starter_packs';
import ListsRoute from '@/app/(app)/[username]/lists';

let mockUsername: string | undefined = '@nate';
let mockPathname = '/@nate';

jest.mock('expo-router', () => {
  const React2 = jest.requireActual<typeof import('react')>('react');
  return {
    Slot: () => React2.createElement('MockSlot'),
    useLocalSearchParams: () => ({ username: mockUsername }),
    usePathname: () => mockPathname,
  };
});

// Stubbed to recognisable host elements so PRESENCE is asserted against the
// real output tree rather than a spy that is never wired into the code path.
jest.mock('@/components/NotFoundScreen', () => {
  const React2 = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: () => React2.createElement('MockNotFound') };
});
jest.mock('@/components/ProfileScreen', () => {
  const React2 = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ({ tab }: { tab?: ProfileTab }) => React2.createElement('MockProfileScreen', { tab }),
  };
});

function renderLayout(pathname: string, username: string | undefined) {
  mockPathname = pathname;
  mockUsername = username;
  let created: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    created = TestRenderer.create(<UsernameLayout />);
  });
  if (!created) throw new Error(`layout did not render at ${pathname}`);
  return created;
}

/** Every URL the `[username]` segment serves, profile and sub-route alike. */
const PROFILE_PATHNAMES = [
  '/@nate',
  '/@nate/replies',
  '/@nate/media',
  '/@nate/videos',
  '/@nate/likes',
  '/@nate/boosts',
  '/@nate/feeds',
  '/@nate/starter_packs',
  '/@nate/lists',
  '/@nate/about',
  '/@nate/followers',
  '/@nate/following',
  '/@nate/who-may-know',
  '/@nate/in-common',
  // Federated handles carry a second `@` and a dot; they route through the very
  // same segment, so the invariant has to hold for them too.
  '/@mrlovenstein@mastodon.social',
  '/@mrlovenstein@mastodon.social/about',
];

describe('[username] layout', () => {
  it.each(PROFILE_PATHNAMES)('renders the segment navigator at %s', (pathname) => {
    const renderer = renderLayout(pathname, pathname.split('/')[1]);

    expect(
      renderer.root.findAllByType('MockSlot' as unknown as React.ComponentType),
    ).toHaveLength(1);
    // Nothing but the navigator: a screen rendered here instead of behind the
    // navigator is the shape that broke, whichever screen it is.
    expect(
      renderer.root.findAllByType('MockProfileScreen' as unknown as React.ComponentType),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('renders the same navigator element type for the profile and its sub-routes', () => {
    const profileRenderer = renderLayout('/@nate', '@nate');
    const aboutRenderer = renderLayout('/@nate/about', '@nate');

    // Reconciliation keys on the element TYPE: if these differ, moving between
    // the two URLs unmounts and remounts the navigator underneath the segment.
    expect(profileRenderer.toJSON()).not.toBeNull();
    expect(aboutRenderer.toJSON()).toEqual(profileRenderer.toJSON());

    act(() => profileRenderer.unmount());
    act(() => aboutRenderer.unmount());
  });

  it.each([['nate'], ['robots.txt'], [undefined]])(
    'renders the 404 for the non-profile handle %s',
    (username) => {
      const renderer = renderLayout('/nate', username);

      expect(
        renderer.root.findAllByType('MockNotFound' as unknown as React.ComponentType),
      ).toHaveLength(1);
      expect(
        renderer.root.findAllByType('MockSlot' as unknown as React.ComponentType),
      ).toHaveLength(0);

      act(() => renderer.unmount());
    },
  );
});

describe('[username] tab routes', () => {
  // The tabs the layout used to derive from the pathname. Each is now its own
  // screen, so the URL and the rendered tab cannot drift apart.
  const TAB_ROUTES: readonly { file: string; Route: React.ComponentType; tab: ProfileTab }[] = [
    { file: 'index', Route: PostsRoute, tab: 'posts' },
    { file: 'replies', Route: RepliesRoute, tab: 'replies' },
    { file: 'media', Route: MediaRoute, tab: 'media' },
    { file: 'videos', Route: VideosRoute, tab: 'videos' },
    { file: 'likes', Route: LikesRoute, tab: 'likes' },
    { file: 'boosts', Route: BoostsRoute, tab: 'boosts' },
    { file: 'feeds', Route: FeedsRoute, tab: 'feeds' },
    { file: 'starter_packs', Route: StarterPacksRoute, tab: 'starter_packs' },
    { file: 'lists', Route: ListsRoute, tab: 'lists' },
  ];

  it.each(TAB_ROUTES)('route $file renders the profile on the $tab tab', ({ file, Route, tab }) => {
    let created: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      created = TestRenderer.create(<Route />);
    });
    if (!created) throw new Error(`route ${file} did not render`);
    const renderer = created;

    const rendered = renderer.root.findAllByType(
      'MockProfileScreen' as unknown as React.ComponentType,
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0].props.tab).toBe(tab);

    act(() => renderer.unmount());
  });
});
