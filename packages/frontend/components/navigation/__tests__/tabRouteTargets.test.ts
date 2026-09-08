import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { PAGES } from '../tabs';

/**
 * Every tab must name a route that exists, and every route in the tabs group
 * must be named by a tab.
 *
 * The equality is the point, in both directions:
 *
 * - A tab pointing at a route file that is not there is a bar button that
 *   navigates to "This screen does not exist". Nothing else catches it:
 *   `typedRoutes` is on but INERT on expo-router 57 — measured in this repo, see
 *   `app/(app)/settings/__tests__/settingsRouteTargets.test.ts` — so a dead
 *   `href` type-checks, ships, and fails under a thumb.
 * - A route file in `(tabs)/` that `PAGES` does not name is worse than dead: the
 *   pager renders the NAVIGATOR's routes, in the navigator's order, and indexes
 *   everything else off `PAGES`. An extra route silently shifts one against the
 *   other, and the symptom is a tap landing on the neighbouring screen — which
 *   reads as a gesture bug rather than a routing one. It would also be preloaded
 *   as a neighbour, since a route the table has never heard of declares no
 *   opt-out.
 *
 * Both halves come from the real `app/` tree rather than a written list, so they
 * cannot drift from routing the way a second copy would.
 */

const appRoot = resolve(__dirname, '../../..', 'app');
const tabsRoot = join(appRoot, '(app)', '(tabs)');

/** Vacuity floors — a walk that finds nothing must fail, not pass quietly. */
const MINIMUM_KNOWN_ROUTES = 40;

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
 * A platform suffix (`.web`) is dropped too — both forks serve one route.
 */
function routePathFor(file: string): string {
  const withoutExtension = relative(appRoot, file).replace(/(\.(web|native|ios|android))?\.tsx?$/, '');
  const segments = withoutExtension.split('/').filter((segment) => !/^\(.+\)$/.test(segment));
  if (segments.at(-1) === 'index') segments.pop();
  return `/${segments.join('/')}`;
}

const knownRoutes = new Set(walk(appRoot).map(routePathFor));

/** Route files directly under `(tabs)/`, excluding the layout itself. */
const tabRouteFiles = walk(tabsRoot).filter(
  (file) => !/(^|\/)_layout(\.[a-z]+)?\.tsx?$/.test(file),
);

describe('the tab table and the tabs group agree', () => {
  it('walked a plausible number of routes (guards against a vacuous pass)', () => {
    expect(knownRoutes.size).toBeGreaterThanOrEqual(MINIMUM_KNOWN_ROUTES);
    expect(tabRouteFiles.length).toBeGreaterThan(0);
  });

  it.each(PAGES.map((page) => [page.name, page.href] as const))(
    'the %s page (%s) resolves to a real route file',
    (_name, href) => {
      expect(typeof href).toBe('string');
      expect(knownRoutes).toContain(href);
    },
  );

  it('the group contains exactly the pages, and in no other quantity', () => {
    const inGroup = [...new Set(tabRouteFiles.map(routePathFor))].sort();
    const declared = PAGES.map((page) => page.href as string).sort();
    expect(inGroup).toEqual(declared);
  });

  it('every page name matches its route file, since the navigator switches by NAME', () => {
    // `navigation.navigate(page.name)` is how a committed swipe and a tapped bar
    // button both reach a screen (`(tabs)/_layout.tsx`), and the name expo-router
    // gives a route is its filename without the extension.
    const fileNames = new Set(
      tabRouteFiles.map((file) =>
        relative(tabsRoot, file).replace(/(\.(web|native|ios|android))?\.tsx?$/, ''),
      ),
    );
    for (const page of PAGES) {
      expect(fileNames).toContain(page.name);
    }
  });
});
