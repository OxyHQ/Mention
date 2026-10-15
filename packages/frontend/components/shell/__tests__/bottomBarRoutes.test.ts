import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bottomBarContent, hidesBottomBar } from '../bottomBarRoutes';

describe('hidesBottomBar', () => {
  // The pushed composer: the tab bar and the FAB sat on its footer (#1140).
  it('hides the bar over the pushed composer', () => {
    expect(hidesBottomBar('/compose')).toBe(true);
  });

  it.each([
    '/',
    '/videos',
    '/notifications',
    '/you',
    '/aid',
    '/@ai',
    '/write',
    '/composer',
    undefined,
    null,
    '',
  ])('keeps the bar on %p', (pathname) => {
    expect(hidesBottomBar(pathname)).toBe(false);
  });

  it('is what the app shell consults before drawing the bar', () => {
    const layout = readFileSync(
      join(__dirname, '..', '..', '..', 'app', '(app)', '_layout.tsx'),
      'utf8',
    );
    expect(layout).toMatch(
      /bottomBarContent\(\{\s*pathname,\s*keyboardVisible,\s*isAuthenticated,\s*isAuthResolved,?\s*\}\)/,
    );
    expect(layout).toMatch(/bottomBar=\{bottomBar\}/);
  });
});

/**
 * The anonymous sign-in invitation is a shell bottom bar too (#1216): inline
 * after the route it rode every change in the page's height down the viewport.
 */
describe('bottomBarContent', () => {
  const base = {
    pathname: '/@nate',
    keyboardVisible: false,
    isAuthenticated: false,
    isAuthResolved: true,
  };

  it('pins the tab bar for a signed-in reader', () => {
    expect(bottomBarContent({ ...base, isAuthenticated: true })).toBe('tabs');
  });

  it('pins the sign-in invitation for a resolved anonymous reader', () => {
    expect(bottomBarContent(base)).toBe('sign-in');
  });

  it('shows no invitation while the session is still resolving', () => {
    expect(bottomBarContent({ ...base, isAuthResolved: false })).toBeNull();
  });

  it('draws nothing on the full-screen composer, signed in or not', () => {
    expect(bottomBarContent({ ...base, pathname: '/compose' })).toBeNull();
    expect(bottomBarContent({ ...base, pathname: '/compose', isAuthenticated: true })).toBeNull();
  });

  it('draws nothing over the keyboard', () => {
    expect(bottomBarContent({ ...base, keyboardVisible: true })).toBeNull();
    expect(bottomBarContent({ ...base, keyboardVisible: true, isAuthenticated: true })).toBeNull();
  });
});
