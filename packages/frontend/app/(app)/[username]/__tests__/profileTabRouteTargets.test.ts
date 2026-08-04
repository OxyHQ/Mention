import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { TAB_NAMES, CHANNEL_ONLY_TAB_NAMES } from '@/components/Profile/types';

/**
 * Every profile tab must have a route file behind it.
 *
 * The profile strip navigates by building a path from a tab NAME
 * (`/@handle/${tab}`, with `posts` collapsing to `/@handle`), so a tab whose
 * route file is missing, renamed, or moved into the wrong directory produces a
 * dead tab — and nothing else catches it. `typedRoutes` is on and does not
 * narrow `Href` on this expo-router major (measured in this repo and documented
 * in the settings gate next door), so a dead tab type-checks, ships, and fails
 * under a user's thumb.
 *
 * It matters more than usual right now: the tab routes are moving into a nested
 * `(tabs)` group so the navigator enumerates only routes that have triggers.
 * `(group)` segments are URL-transparent, so that move should change no path at
 * all — and this test is what proves it, rather than a click-through.
 *
 * The tab list is read from the SOURCE OF TRUTH (`Profile/types.ts`) rather than
 * restated here, so adding a tab without a route fails immediately instead of
 * whenever someone next opens the profile.
 *
 * Scoped to profile tabs deliberately. `[username]` is a dynamic segment, but
 * these routes are static BELOW it, so the check compares route SHAPES
 * (`/[username]/replies`) and has no dynamic-segment false positives to
 * litigate — the same reason the settings gate is scoped the way it is.
 */

const appRoot = resolve(__dirname, '../../..');
const profileRoot = resolve(__dirname, '..');

/** Vacuity floors — a broken walk must not read as "nothing is wrong". */
const MINIMUM_KNOWN_ROUTES = 40;
const MINIMUM_PROFILE_FILES = 12;
const MINIMUM_TABS = 6;

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' || entry === 'node_modules' ? [] : walk(path);
    }
    return /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path) ? [path] : [];
  });
}

/**
 * The route path expo-router serves a file at: `(group)` segments are
 * transparent, `index` is the directory itself, and the extension is dropped.
 * A layout is not a route.
 */
function routePathFor(file: string): string {
  const withoutExtension = relative(appRoot, file).replace(/\.tsx?$/, '');
  const segments = withoutExtension
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment));
  if (segments.at(-1) === 'index') segments.pop();
  return `/${segments.join('/')}`;
}

const routeFiles = walk(appRoot).filter((file) => !/_layout\.tsx?$/.test(file));
const knownRoutes = new Set(routeFiles.map(routePathFor));
const profileFiles = walk(profileRoot);

/** Where the strip sends each tab, mirroring the path the profile builds. */
function routeForTab(tab: string): string {
  return tab === 'posts' ? '/[username]' : `/[username]/${tab}`;
}

describe('every profile tab has a route behind it', () => {
  it('inspected a plausible amount of the tree', () => {
    expect(knownRoutes.size).toBeGreaterThanOrEqual(MINIMUM_KNOWN_ROUTES);
    expect(profileFiles.length).toBeGreaterThanOrEqual(MINIMUM_PROFILE_FILES);
    expect(TAB_NAMES.length).toBeGreaterThanOrEqual(MINIMUM_TABS);
  });

  it.each(TAB_NAMES)('%s resolves to a route file', (tab) => {
    expect(knownRoutes.has(routeForTab(tab))).toBe(true);
  });

  /**
   * The channel-only tabs are deliberately NOT routes, and asserting that is the
   * point: `/c/<handle>` is ONE route with no sub-tabs beneath it
   * (`components/ChannelScreen.tsx`), so a channel's tabs are local state and
   * carry nothing in the URL. Only `TAB_NAMES` — the person-profile tabs — are
   * routed, which is why the loop above uses that list rather than `ProfileTab`.
   *
   * Written as an assertion rather than an omission so that giving a channel tab
   * a route, or routing channel tabs generally, fails here and forces the person
   * making that change to decide what it means for this gate.
   */
  it.each(CHANNEL_ONLY_TAB_NAMES)('%s is a channel tab and therefore NOT routed', (tab) => {
    expect(knownRoutes.has(routeForTab(tab))).toBe(false);
    expect(knownRoutes.has(`/c/[username]/${tab}`)).toBe(false);
  });

  it('serves the default tab at the bare profile path', () => {
    // `/@handle` must be the posts tab, not a redirect — every link in the wild
    // points at it, including the OG shell the backend serves.
    expect(knownRoutes.has('/[username]')).toBe(true);
  });

  it('keeps a lane reachable under its own segment', () => {
    // Lanes route by id rather than by name, so they cannot collide with a
    // static tab file however a publisher names their lane.
    expect(knownRoutes.has('/[username]/lane/[laneId]')).toBe(true);
  });

  it('keeps the non-tab profile routes reachable', () => {
    // These are siblings of the tabs, NOT tabs. They must stay outside whatever
    // navigator owns the tab strip: a route the navigator does not declare as a
    // trigger is not given a screen at all, and expo-router then silently
    // rewrites the URL to the navigator's first tab — measured, no 404 and no
    // console warning. Six live routes ride on that distinction.
    for (const route of [
      '/[username]/followers',
      '/[username]/following',
      '/[username]/about',
      '/[username]/connections',
      '/[username]/in-common',
      '/[username]/who-may-know',
    ]) {
      expect(knownRoutes.has(route)).toBe(true);
    }
  });
});
