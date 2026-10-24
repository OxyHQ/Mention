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
});

/**
 * The anonymous sign-in invitation is a shell bottom bar too (#1216): inline
 * after the route it rode every change in the page's height down the viewport.
 */
describe('bottomBarContent', () => {
  const base = {
    pathname: '/@nate',
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
});
