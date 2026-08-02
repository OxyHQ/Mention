import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Every route a settings screen navigates to must exist.
 *
 * This exists because nothing else catches a settings row left pointing at a
 * moved or deleted screen. `typedRoutes` is enabled, but on expo-router 57 it
 * does NOT narrow `Href` — measured in this repo:
 * `router.push('/settings/fediverse/nodez')` type-checks clean both with and
 * without `.expo/types/router.d.ts` generated, while a deliberate
 * `const x: number = 'string'` in the same file IS reported. So the type-checker
 * is not a gate here, and a dead row compiles, ships, and only fails under a
 * user's thumb as "This screen does not exist."
 *
 * Scoped to the settings tree on purpose: those routes are all static, so the
 * check has no dynamic-segment false positives to litigate. It reads the real
 * `app/` tree rather than a hard-coded list, so it cannot drift from routing.
 */

const appRoot = resolve(__dirname, '../../..');
const settingsRoot = resolve(__dirname, '..');

/** Vacuity floors — a broken walk must not read as "nothing is wrong". */
const MINIMUM_SETTINGS_FILES = 15;
const MINIMUM_PUSHED_ROUTES = 10;
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
 */
function routePathFor(file: string): string {
  const withoutExtension = relative(appRoot, file).replace(/\.tsx?$/, '');
  const segments = withoutExtension
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment));
  if (segments.at(-1) === 'index') segments.pop();
  return `/${segments.join('/')}`;
}

const knownRoutes = new Set(walk(appRoot).map(routePathFor));

const settingsFiles = walk(settingsRoot);

/** Every `router.push('/…')` / `router.replace('/…')` literal, with its file. */
const pushedRoutes = settingsFiles.flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return Array.from(
    source.matchAll(/\.(?:push|replace|navigate)\(\s*['"](\/[^'"]*)['"]/g),
    (match) => ({ route: match[1], file: relative(appRoot, file) }),
  );
});

describe('every route a settings screen navigates to exists', () => {
  it('inspected a plausible amount of the settings tree', () => {
    expect(settingsFiles.length).toBeGreaterThanOrEqual(MINIMUM_SETTINGS_FILES);
    expect(pushedRoutes.length).toBeGreaterThanOrEqual(MINIMUM_PUSHED_ROUTES);
    expect(knownRoutes.size).toBeGreaterThanOrEqual(MINIMUM_KNOWN_ROUTES);
  });

  it.each(pushedRoutes)('$file → $route', ({ route }) => {
    // Query strings and hashes are not part of the file-backed path.
    const path = route.split(/[?#]/)[0].replace(/\/$/, '') || '/';
    expect(knownRoutes.has(path)).toBe(true);
  });

  it('keeps the fediverse area behind one door', () => {
    // The hub and its subscreens exist…
    expect(knownRoutes.has('/settings/fediverse')).toBe(true);
    expect(knownRoutes.has('/settings/fediverse/node')).toBe(true);
    // …and the routes they replaced are gone, with no compatibility stub.
    expect(knownRoutes.has('/settings/node')).toBe(false);

    // Transparency stays a public top-level route the hub links to, rather than
    // a settings subscreen, because it is addressed to people who are not
    // signed in and gets cited by URL.
    expect(knownRoutes.has('/transparency')).toBe(true);
  });
});
