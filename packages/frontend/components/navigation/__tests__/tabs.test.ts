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

  it("counts the VIEWER's own /@handle as the profile tab", () => {
    // On web `/you` redirects to `/@handle`; without this the bar would show no
    // selection on the one profile a reader looks at most.
    expect(tabIndexForPathname('/@ana', 'ana')).toBe(4);
  });

  it("does NOT count somebody else's /@handle", () => {
    expect(tabIndexForPathname('/@someone-else', 'ana')).toBe(-1);
  });

  it('does not count the viewer\'s own profile SUB-routes', () => {
    // `/@ana/replies` is a pushed route like any other. Matching it would light
    // the profile tab while the reader is somewhere the tab cannot return them.
    expect(tabIndexForPathname('/@ana/replies', 'ana')).toBe(-1);
  });

  it('needs a viewer to match a handle at all', () => {
    expect(tabIndexForPathname('/@ana')).toBe(-1);
  });
});
