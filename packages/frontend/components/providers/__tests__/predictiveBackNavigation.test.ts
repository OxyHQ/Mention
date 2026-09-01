import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Predictive Back is implemented by Expo Router's ExperimentalStack on Android.
 * The standard Stack still lets Android finish the Activity, and Expo explicitly
 * forbids mixing the two native stack implementations in one app.
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
  it('enables the native Android callback in app config', () => {
    const appConfig = readFileSync(join(frontendRoot, 'app.config.js'), 'utf8');
    expect(appConfig).toMatch(/predictiveBackGestureEnabled:\s*true/);
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
    const patchPath = rootPackage.patchedDependencies?.['expo-router@57.0.9'];

    expect(patchPath).toBe('patches/expo-router@57.0.9.patch');
    expect(readFileSync(join(repositoryRoot, patchPath!), 'utf8')).toContain(
      'options.headerShown === false ? null',
    );
  });
});
