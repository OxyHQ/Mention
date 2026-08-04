import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  profileTabHref,
  profileTabSelectionFromPathname,
} from '../profileTabRoute';
import { TAB_NAMES, laneTabKey } from '../types';

/**
 * Which profile URLs get the tab chrome, and which get none.
 *
 * This is the boundary the reverted `(tabs)` group used to draw with a folder.
 * Drawing it from the pathname instead is what lets the tab routes stay FLAT —
 * a pushed `[username]` entry's default child has to be a real route, or the
 * child navigator picks a sibling and expo-router writes `/@handle/about` into
 * the URL (see `ProfileChromeFrame.web.tsx`). So the classification below is
 * load-bearing in both directions, and neither direction fails loudly on its
 * own: a tab misread as a sibling silently loses its chrome, and a sibling
 * misread as a tab gets a banner and a tab strip stacked above its own header.
 *
 * The two route families are read from the REAL directory rather than restated,
 * so a route added later is classified by this test the day it lands.
 */

const PROFILE_ROUTES = join(__dirname, '..', '..', '..', 'app', '(app)', '[username]');

/** Vacuity floors — a broken walk must not read as "nothing is wrong". */
const MINIMUM_ROUTE_FILES = 12;
const MINIMUM_TABS = 6;

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : walk(path);
    }
    return /\.tsx?$/.test(path) && !/_layout\.tsx?$/.test(path) ? [path] : [];
  });
}

/**
 * The pathname a route file is served at, for the handle `@ana`. `index` is the
 * directory itself; a dynamic segment gets a value, since this function's whole
 * job is to produce something a reader could actually be sitting on.
 */
function pathnameFor(file: string): string {
  const segments = relative(PROFILE_ROUTES, file)
    .replace(/\.tsx?$/, '')
    .split('/')
    .map((segment) => (segment === '[laneId]' ? 'lane-42' : segment))
    .filter((segment) => segment !== 'index');
  return ['/@ana', ...segments].join('/');
}

const ROUTE_FILES = walk(PROFILE_ROUTES);
const ROUTE_PATHNAMES = ROUTE_FILES.map(pathnameFor);

/** Every route this segment serves that IS one of the profile's tabs. */
const TAB_PATHNAMES = ROUTE_PATHNAMES.filter((pathname) => {
  const [, second] = pathname.split('/').filter(Boolean);
  return second === undefined || second === 'lane' || (TAB_NAMES as readonly string[]).includes(second);
});

/** Everything else it serves: full screens with their own header and back arrow. */
const SIBLING_PATHNAMES = ROUTE_PATHNAMES.filter((pathname) => !TAB_PATHNAMES.includes(pathname));

describe('which profile URLs are tabs', () => {
  it('walked a plausible amount of the segment', () => {
    expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(MINIMUM_ROUTE_FILES);
    expect(TAB_NAMES.length).toBeGreaterThanOrEqual(MINIMUM_TABS);
    // Both halves must be non-empty, or one of the two loops below asserts
    // nothing while still reporting green.
    expect(TAB_PATHNAMES.length).toBeGreaterThan(1);
    expect(SIBLING_PATHNAMES.length).toBeGreaterThan(1);
  });

  it.each(TAB_PATHNAMES)('%s is a tab and gets the chrome', (pathname) => {
    expect(profileTabSelectionFromPathname(pathname)).not.toBeNull();
  });

  it.each(SIBLING_PATHNAMES)('%s is its own screen and gets none', (pathname) => {
    expect(profileTabSelectionFromPathname(pathname)).toBeNull();
  });

  it('serves the posts tab at the bare profile path', () => {
    // `/@handle` must BE the posts tab rather than redirect to it: every link in
    // the wild points there, including the OG shell the backend serves.
    expect(profileTabSelectionFromPathname('/@ana')).toEqual({ tab: 'posts', key: 'posts' });
  });

  it('reads a federated handle positionally, not by matching it', () => {
    // A federated handle carries a second `@` and a dot, and arrives
    // percent-encoded often enough that comparing it is a way to be wrong.
    expect(profileTabSelectionFromPathname('/@ana@mastodon.social/replies')).toEqual({
      tab: 'replies',
      key: 'replies',
    });
    expect(profileTabSelectionFromPathname('/@ana@mastodon.social/followers')).toBeNull();
  });

  it('carries the lane id out of the URL', () => {
    expect(profileTabSelectionFromPathname('/@ana/lane/abc123')).toEqual({
      tab: 'posts',
      laneId: 'abc123',
      key: laneTabKey('abc123'),
    });
    // The segment without an id is not a route, and must not read as one.
    expect(profileTabSelectionFromPathname('/@ana/lane')).toBeNull();
  });

  it('gives an unknown child no chrome rather than a guess', () => {
    // The direction that fails safe: a route added to this segment later gets
    // its own screen untouched until somebody decides it is a tab.
    expect(profileTabSelectionFromPathname('/@ana/something-new')).toBeNull();
    expect(profileTabSelectionFromPathname('/@ana/replies/deeper')).toBeNull();
    expect(profileTabSelectionFromPathname('/')).toBeNull();
  });

  it('does not accept the URL the posts tab collapses away', () => {
    // `profileTabHref` sends `posts` to the bare path, so `/@ana/posts` is a URL
    // nothing produces and no file serves.
    expect(profileTabSelectionFromPathname('/@ana/posts')).toBeNull();
  });
});

describe('where the strip sends each tab', () => {
  it.each(TAB_NAMES)('%s round-trips through its own href', (tab) => {
    const href = profileTabHref('ana', { key: tab, label: tab, tab });
    expect(typeof href).toBe('string');
    expect(profileTabSelectionFromPathname(href as string)?.key).toBe(tab);
  });

  it('round-trips a lane tab', () => {
    const href = profileTabHref('ana', {
      key: laneTabKey('abc123'),
      label: 'Reviews',
      tab: 'posts',
      laneId: 'abc123',
    });
    expect(href).toBe('/@ana/lane/abc123');
    expect(profileTabSelectionFromPathname(href as string)).toEqual({
      tab: 'posts',
      laneId: 'abc123',
      key: laneTabKey('abc123'),
    });
  });
});
