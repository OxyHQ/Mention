import { TABS, tabIndexByName, tabIndexForPathname } from '../tabs';

/**
 * Which tab a route is, which is the question the whole bottom bar hangs on.
 *
 * `tabIndexForPathname` decides whether the highlight is drawn at all: Bloom's
 * `TabBar` treats an index naming no tab as NO SELECTION and fades the capsule
 * out where it stands. So a wrong answer here is either a bar asserting a tab on
 * a screen that is not one, or a bar going blank on a screen that is.
 *
 * The `/@<handle>` case is the one worth testing hardest, because it is
 * asymmetric on purpose: the VIEWER's own profile counts as the profile tab (on
 * web `/you` redirects there, since the profile chrome lives in the `[username]`
 * layout), and anybody else's is a pushed route that must select nothing.
 */

describe('the tab table', () => {
  it('has the five root destinations, in bar order', () => {
    expect(TABS.map((tab) => tab.name)).toEqual([
      'index',
      'videos',
      'write',
      'notifications',
      'you',
    ]);
  });

  it('opts the composer out of neighbour preloading, and nothing else', () => {
    // Preloading a neighbour is what stops a page being blank under the finger,
    // and it is worth the mount for a feed. The composer is the app's heaviest
    // screen and mounting it merely for being swiped PAST would spend exactly
    // the cost the tabs rewrite removes.
    expect(TABS.filter((tab) => !tab.preload).map((tab) => tab.name)).toEqual(['write']);
  });
});

describe('tabIndexByName', () => {
  it('resolves each tab to its position', () => {
    expect(tabIndexByName('index')).toBe(0);
    expect(tabIndexByName('you')).toBe(4);
  });

  it('answers -1 for a name that is not a tab', () => {
    // `BottomBar` derives its two named indices through this. A silent 0 would
    // make "re-tapping Home refreshes" fire on whatever tab happened to be first.
    expect(tabIndexByName('nope')).toBe(-1);
  });
});

describe('tabIndexForPathname', () => {
  it.each([
    ['/', 0],
    ['/videos', 1],
    ['/write', 2],
    ['/notifications', 3],
    ['/you', 4],
  ])('matches %s to tab %i', (pathname, index) => {
    expect(tabIndexForPathname(pathname)).toBe(index);
  });

  it.each([
    ['/p/abc123'],
    ['/settings/notifications'],
    ['/explore'],
    ['/notifications/pokes'],
    ['/compose'],
  ])('answers -1 on %s, which is pushed OVER the tabs', (pathname) => {
    // -1 is the common answer, not an error case: the bar renders over every
    // pushed route and must show no selection there.
    expect(tabIndexForPathname(pathname)).toBe(-1);
  });

  it('answers -1 with no pathname at all', () => {
    expect(tabIndexForPathname(undefined)).toBe(-1);
    expect(tabIndexForPathname(null)).toBe(-1);
    expect(tabIndexForPathname('')).toBe(-1);
  });

  it('needs a viewer to match a handle at all', () => {
    expect(tabIndexForPathname('/@ana')).toBe(-1);
  });
});

/**
 * The profile tab is the one entry whose destination differs by platform, and
 * `tabHref` is the single place that says so. Both sides are asserted here
 * because the preset runs as iOS: the web branch would otherwise be code nothing
 * ever executes, and "the bar points at `/@handle` on web" is exactly the claim
 * the last profile-tab bug was made of.
 */
describe('tabHref, per platform', () => {
  function loadFor(os: 'ios' | 'web') {
    let mod!: typeof import('../tabs');
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({ Platform: { OS: os } }));
      mod = require('../tabs') as typeof import('../tabs');
    });
    return mod;
  }

  afterEach(() => {
    jest.dontMock('react-native');
  });

  it('sends web to the viewer\'s own /@handle', () => {
    const web = loadFor('web');
    const you = web.TABS[web.tabIndexByName('you')]!;
    expect(web.tabHref(you, 'ana')).toBe('/@ana');
    expect(web.tabIndexForPathname('/@ana', 'ana')).toBe(4);
  });

  it('keeps web on /you when nobody is signed in', () => {
    // There is no handle to send to, and `/you` renders the sign-in prompt.
    const web = loadFor('web');
    const you = web.TABS[web.tabIndexByName('you')]!;
    expect(web.tabHref(you, undefined)).toBe('/you');
  });

  it('keeps NATIVE on /you, where /@handle is a pushed route', () => {
    // Treating it as the tab there would light the pill for a screen sitting
    // OVER the tabs — a copy of your own profile opened from a post row.
    const native = loadFor('ios');
    const you = native.TABS[native.tabIndexByName('you')]!;
    expect(native.tabHref(you, 'ana')).toBe('/you');
    expect(native.tabIndexForPathname('/@ana', 'ana')).toBe(-1);
  });

  it("never counts somebody else's /@handle, on either platform", () => {
    for (const os of ['web', 'ios'] as const) {
      expect(loadFor(os).tabIndexForPathname('/@someone-else', 'ana')).toBe(-1);
    }
  });

  it('does not count the viewer\'s own profile SUB-routes on web', () => {
    // `/@ana/replies` is a pushed route like any other. Matching it would light
    // the profile tab while the reader is somewhere the tab cannot return them.
    expect(loadFor('web').tabIndexForPathname('/@ana/replies', 'ana')).toBe(-1);
  });
});
