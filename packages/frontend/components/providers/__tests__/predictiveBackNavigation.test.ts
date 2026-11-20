import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Native ownership is shared by Bloom's root pager and Expo's native stack.
 * These wiring checks supplement shared behavioral tests and device acceptance.
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
  ).flatMap((body) =>
    body
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

describe('Android predictive-back navigation wiring', () => {
  it('enables predictive Back with the source-built ownership coordinator', () => {
    const appConfig = readFileSync(join(frontendRoot, 'app.config.js'), 'utf8');
    expect(appConfig).toMatch(/predictiveBackGestureEnabled:\s*true/);
    expect(appConfig).toMatch(/buildReactNativeFromSource:\s*true/);
    expect(appConfig).toMatch(/\['@oxy\.so\/bloom',\s*\{\s*predictiveBack:\s*true/);
  });

  it('builds every app-owned stack with the Bloom language’s Stack (ExperimentalStack on Android)', () => {
    // The language's Stack is expo-router's ExperimentalStack on Android and
    // OxyOS (Bloom's router tests hold it); no route imports a stack itself.
    const routerStacks = navigationSources.flatMap(({ path, source }) =>
      importedExpoRouterNames(source)
        .filter((name) => /^(?:Experimental)?Stack(?:\s+as\s+\w+)?$/.test(name))
        .map(() => path),
    );
    const languageStacks = navigationSources.filter(({ source }) =>
      /import\s*\{[^}]*\bStack\b[^}]*\}\s*from\s*['"]@oxy\.so\/bloom-language\/router['"]/.test(
        source,
      ),
    );

    expect(routerStacks).toEqual([]);
    expect(languageStacks.map(({ path }) => path.slice(appRoot.length + 1)).sort()).toEqual([
      '(app)/(tabs)/notifications/_layout.tsx',
      '(app)/(tabs)/you/_layout.tsx',
      '(app)/_layout.tsx',
    ]);
  });

  it('keeps the hidden-header crash workaround installed', () => {
    const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      patchedDependencies?: Record<string, string>;
    };
    const patchPath = rootPackage.patchedDependencies?.['expo-router@58.0.30'];

    expect(patchPath).toBe('patches/expo-router@58.0.30.patch');
    expect(readFileSync(join(repositoryRoot, patchPath!), 'utf8')).toContain(
      'options.headerShown === false ? null',
    );
  });
});
