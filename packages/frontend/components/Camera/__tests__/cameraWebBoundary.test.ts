import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * `expo-camera` must not reach a WEB bundle, and a route fork does not stop it.
 *
 * This is a measured regression, not a precaution. `expo-camera` ships a real
 * web build, so nothing breaks when it reaches web — it simply ships. And it
 * did: with the capture surface's import sitting in `app/(app)/(tabs)/camera.tsx`
 * and a `camera.web.tsx` beside it, `expo export --platform web` still emitted a
 * 31KB `camera-*.js` chunk carrying the package, because expo-router puts EVERY
 * route file in the graph and a platform sibling does not remove its twin.
 *
 * What does work is a MODULE fork: the route re-exports `CameraPage`, and Metro
 * resolves it to `CameraPage.web.tsx` on web, so nothing on that side names the
 * capture surface or the package at all.
 *
 * So the boundary is "which module imports it", and that is what this pins.
 * Moving the import up into the route file type-checks, renders correctly on
 * both platforms, and silently puts it back in `dist/`.
 */

const FRONTEND = resolve(__dirname, '..', '..', '..');
const SEARCH_ROOTS = ['app', 'components', 'hooks', 'lib', 'utils', 'stores', 'services'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const allSources = SEARCH_ROOTS.flatMap((root) => sourceFiles(join(FRONTEND, root)));

/** Files that NAME the package — an import, not a mention in prose. */
const importers = allSources.filter((file) =>
  /from\s+['"]expo-camera['"]|require\(['"]expo-camera['"]\)/.test(readFileSync(file, 'utf8')),
);

describe('the camera stays out of the web bundle', () => {
  it('walked a plausible number of files (guards against a vacuous pass)', () => {
    expect(allSources.length).toBeGreaterThan(200);
  });

  it('is imported by exactly one module, reached only through the forked page', () => {
    expect(importers.map((file) => file.replace(`${FRONTEND}/`, ''))).toEqual([
      'components/Camera/CameraCapture.tsx',
    ]);
    const captureImporters = allSources.filter((file) =>
      /from\s+['"](?:@\/components\/Camera|\.)\/CameraCapture['"]/.test(readFileSync(file, 'utf8')),
    );
    expect(captureImporters.map((file) => file.replace(`${FRONTEND}/`, ''))).toEqual([
      'components/Camera/CameraPage.tsx',
    ]);
  });

  it('and the web fork of the page names neither', () => {
    // The failure this catches is a fork that re-exports the native page, or one
    // that imports a type from it — either puts the package straight back.
    const web = readFileSync(join(FRONTEND, 'components/Camera/CameraPage.web.tsx'), 'utf8');
    expect(web).not.toMatch(/from\s+['"]expo-camera['"]|CameraCapture['"]|CameraPage['"]/);
  });

  it('and the route file only re-exports the forked page', () => {
    // The specific mistake: a `camera.web.tsx` route sibling looks handled, and
    // the native route file ships anyway.
    expect(existsSync(join(FRONTEND, 'app/(app)/(tabs)/camera.web.tsx'))).toBe(false);
    expect(readFileSync(join(FRONTEND, 'app/(app)/(tabs)/camera.tsx'), 'utf8')).toMatch(
      /export \{ default \} from '@\/components\/Camera\/CameraPage';/,
    );
  });
});
