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
 * What does work is a MODULE fork: Metro resolves `./CameraCapture` to
 * `CameraCapture.web.tsx` on web, so nothing on that side names the package at
 * all. Same mechanism as `TabsPager.web.tsx` and `react-native-pager-view`.
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

  it('is imported by exactly one module, and that module is web-forked', () => {
    expect(importers.map((file) => file.replace(`${FRONTEND}/`, ''))).toEqual([
      'components/Camera/CameraCapture.tsx',
    ]);

    for (const file of importers) {
      // The fork is what a web bundler resolves INSTEAD. Without a sibling,
      // `expo-camera` is simply what web gets.
      expect(existsSync(file.replace(/\.tsx$/, '.web.tsx'))).toBe(true);
    }
  });

  it('and the web fork does not name it', () => {
    // The failure this catches is a fork that re-exports the native file, or one
    // that imports a type from it — either puts the package straight back.
    const web = readFileSync(join(FRONTEND, 'components/Camera/CameraCapture.web.tsx'), 'utf8');
    // The same import test used above, not a bare mention of the name: the fork
    // documents WHY it exists, and a doc comment naming the package is the point
    // rather than a violation.
    expect(web).not.toMatch(/from\s+['"]expo-camera['"]|require\(['"]expo-camera['"]\)/);
  });

  it('is never named by a route file, which expo-router bundles regardless', () => {
    // The specific mistake: `camera.web.tsx` exists, so the route looks handled,
    // and the native route file ships anyway.
    const routeImporters = importers.filter((file) => file.includes(`${FRONTEND}/app/`));
    expect(routeImporters).toEqual([]);
  });
});

describe('the camera route itself', () => {
  it('has a web fork, so nobody lands on a page that cannot exist there', () => {
    // A separate concern from the bundle: this one is about what a reader who
    // types `/camera` sees. Both are needed and neither implies the other.
    expect(existsSync(join(FRONTEND, 'app/(app)/(tabs)/camera.web.tsx'))).toBe(true);
  });
});
