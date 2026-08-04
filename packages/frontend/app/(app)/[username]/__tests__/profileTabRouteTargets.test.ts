import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { TAB_NAMES, CHANNEL_ONLY_TAB_NAMES } from '@/components/Profile/types';

/**
 * Every profile tab must have a route file behind it.
 *
 * The profile strip navigates by building a path from a tab NAME
 * (`/@handle/${tab}`, with `posts` collapsing to `/@handle` — see
 * `profileTabHref`), so a tab whose route file is missing, renamed, or moved
 * into another directory produces a dead tab, and nothing else catches it.
 * `typedRoutes` is on and does not narrow `Href` on this expo-router major
 * (measured in this repo and documented in the settings gate next door), so a
 * dead tab type-checks, ships, and fails under a user's thumb.
 *
 * This asserts that the routes EXIST. It does not, and cannot, assert which
 * screen the router picks for a given URL — it passed unchanged through the
 * whole `(tabs)`-group regression, where every route below existed and
 * `/@handle` nonetheless resolved to `about`. Only a real browser can answer
 * that; `packages/e2e/tests/profile-tabs.spec.ts` is where it is answered.
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
 * transparent, `index` is the directory itself, a platform extension names the
 * same route as its default, and the extension is dropped. A layout is not a
 * route.
 */
function routePathFor(file: string): string {
  const withoutExtension = relative(appRoot, file).replace(/(\.(web|native|ios|android))?\.tsx?$/, '');
  const segments = withoutExtension
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment));
  if (segments.at(-1) === 'index') segments.pop();
  return `/${segments.join('/')}`;
}

const routeFiles = walk(appRoot).filter((file) => !/_layout(\.\w+)?\.tsx?$/.test(file));
const knownRoutes = new Set(routeFiles.map(routePathFor));
const profileFiles = walk(profileRoot);

/** Where the strip sends each tab, mirroring `profileTabHref`. */
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
    // These are siblings of the tabs, NOT tabs — full screens with their own
    // header and back arrow. They are flat beside the tab files, and the layout
    // tells the two families apart from the pathname rather than from a folder
    // (`profileTabSelectionFromPathname`). Grouping the tabs to draw that
    // boundary with a directory shipped once and was reverted: a pushed
    // `[username]` entry carries no nested state, and its child navigator
    // settled on `about`.
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

  it('keeps every tab route a DIRECT child of the segment', () => {
    // The reverted regression is the reason this is asserted rather than left
    // implied: the tabs were moved into a `(tabs)` group, every path above
    // stayed identical (a `(group)` segment is URL-transparent, so this file
    // passed), and `/@handle` still stopped resolving to the posts tab. A group
    // between the segment and its tabs is the shape that broke.
    for (const tab of TAB_NAMES) {
      const file = profileFiles.find((path) => routePathFor(path) === routeForTab(tab));
      expect(file).toBeDefined();
      expect(relative(profileRoot, file as string)).not.toMatch(/\(.+\)/);
    }
  });
});
