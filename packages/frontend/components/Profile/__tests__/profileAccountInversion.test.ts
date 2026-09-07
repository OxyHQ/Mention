import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHO IS ALLOWED TO READ THE URL.
 *
 * The profile lookup used to call `useLocalSearchParams()` itself. That is the
 * coupling the whole `/you` mess grew out of: a hook that goes and finds its own
 * segment cannot serve a caller that has a handle and no segment, so the viewer's
 * own profile tab needed an override parameter — and that parameter then had to
 * carry a second, unrelated meaning ("and do not canonicalize"), because `/you`
 * belongs to no URL family. One flag, two jobs, and a redirect chained onto the
 * tab press to make up the difference. That redirect is what stopped the profile
 * tab opening at all.
 *
 * The rule now: ROUTES read the URL, everything downstream takes a value. This
 * pins it, because nothing else would — re-adding `useLocalSearchParams` to the
 * lookup type-checks, renders, and only misbehaves later.
 */

const FRONTEND = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(FRONTEND, rel), 'utf8');

/** Reads the segment, and is named for exactly that. */
const THE_ONE_READER = 'components/Profile/hooks/useRoutedProfileUsername.ts';

describe('the profile lookup takes a handle, and never fetches one', () => {
  it.each([
    'components/Profile/hooks/useProfileAccount.ts',
    'components/Profile/hooks/usePersonProfileView.tsx',
    'components/ProfileScreen.tsx',
    'components/ProfileScreen.web.tsx',
  ])('%s does not read the URL', (rel) => {
    expect(read(rel)).not.toMatch(/useLocalSearchParams/);
  });

  it('and the one hook that does read it is the one named for it', () => {
    expect(read(THE_ONE_READER)).toMatch(/useLocalSearchParams/);
  });
});

describe('nothing renders a profile without saying whose', () => {
  const ROUTES_DIR = join(FRONTEND, 'app', '(app)', '[username]');

  it('every [username] route passes the handle it read', () => {
    const routes = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.tsx') && f !== '_layout.tsx');
    // A guard on the guard: if this directory is ever restructured, an empty
    // list would make every assertion below vacuously true.
    expect(routes.length).toBeGreaterThanOrEqual(9);

    for (const file of routes) {
      const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
      if (!source.includes('<ProfileScreen')) continue;
      expect({ file, passesUsername: /<ProfileScreen\s+username=\{/.test(source) }).toEqual({
        file,
        passesUsername: true,
      });
    }
  });

  it('the /you tab passes the SESSION handle, and no override', () => {
    const source = read('app/(app)/(tabs)/you.tsx');
    expect(source).toMatch(/<ProfileScreen username=\{user\.username\}/);
    expect(source).not.toMatch(/usernameOverride/);
  });
});

describe('canonicalization is asked, never implied', () => {
  it('is a separate hook, so a route with no URL family simply does not call it', () => {
    // The old shape derived it from "was an override passed", which is why
    // turning the override off and turning canonicalization off were the same
    // switch. A channel-kind viewer would otherwise be redirected off their own
    // profile tab the moment the account resolved.
    const source = read('components/Profile/hooks/useProfileAccount.ts');
    expect(source).toMatch(/export function useProfileCanonicalHref/);
    expect(source).not.toMatch(/usernameOverride/);
  });

  it('the /you tab never asks it', () => {
    expect(read('app/(app)/(tabs)/you.tsx')).not.toMatch(/useProfileCanonicalHref/);
  });
});
