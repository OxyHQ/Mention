import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Expo Router's ExperimentalStack is the app's only native stack — the standard
 * Stack lets Android finish the Activity, and Expo forbids mixing the two native
 * stack implementations in one app. That much is unchanged.
 *
 * What changed is the SYSTEM predictive-back gesture, which this file used to
 * require. It is answered entirely natively, and `(tabs)` is the stack's root
 * screen, so a back press finished the Activity before any JavaScript ran: the
 * tab router's `backBehavior: 'history'` was never asked and back LEFT THE APP
 * from every tab, leaving react-native-screens to report "The screen '(tabs)'
 * was removed natively but didn't get removed from JS state" (after which the
 * bottom bar has been seen to disappear). Measured on a Pixel 10 Pro, together
 * with both JS-side rescues failing: `BackHandler` arms and is never called, and
 * `usePreventRemove` stops the exit but its callback only runs from a JS
 * `beforeRemove`, which a native dismiss never emits — so back went inert.
 *
 * The tab history lives in JavaScript, so back has to reach JavaScript. The
 * gesture's PREVIEW animation is what that costs; the stack's own transitions
 * are unaffected.
 */

const frontendRoot = resolve(__dirname, '../../..');
const repositoryRoot = resolve(frontendRoot, '../..');
const appRoot = join(frontendRoot, 'app');
const authRouterPath = resolve(__dirname, '../AuthRouter.tsx');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.[jt]sx?$/.test(path) && !/\.(test|spec)\.[jt]sx?$/.test(path) ? [path] : [];
  });
}

const navigationSources = [...walk(appRoot), authRouterPath].map((path) => ({
  path,
  source: readFileSync(path, 'utf8'),
}));

function importedExpoRouterNames(source: string): string[] {
  return Array.from(
    source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]expo-router['"]/g),
    (match) => match[1],
  ).flatMap((body) => body.split(',').map((name) => name.trim()).filter(Boolean));
}

describe('Android predictive-back navigation wiring', () => {
  it('leaves the native Android back callback to JavaScript', () => {
    const appConfig = readFileSync(join(frontendRoot, 'app.config.js'), 'utf8');
    expect(appConfig).toMatch(/predictiveBackGestureEnabled:\s*false/);
  });

  it('uses ExperimentalStack for every app-owned native navigator', () => {
    const standardStackImports = navigationSources.flatMap(({ path, source }) =>
      importedExpoRouterNames(source)
        .filter((name) => /^Stack(?:\s+as\s+\w+)?$/.test(name))
        .map(() => path),
    );
    const experimentalStackImports = navigationSources.reduce(
      (count, { source }) =>
        count + importedExpoRouterNames(source).filter((name) => name === 'ExperimentalStack').length,
      0,
    );

    expect(standardStackImports).toEqual([]);
    expect(experimentalStackImports).toBe(1);
  });

  it('keeps the hidden-header crash workaround installed', () => {
    const rootPackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { patchedDependencies?: Record<string, string> };
    const patchPath = rootPackage.patchedDependencies?.['expo-router@57.0.18'];

    expect(patchPath).toBe('patches/expo-router@57.0.18.patch');
    expect(readFileSync(join(repositoryRoot, patchPath!), 'utf8')).toContain(
      'options.headerShown === false ? null',
    );
  });
});
