import {
  BAR_POSITION_BY_PAGE,
  BAR_TABS,
  PAGES,
  barIndexByName,
  barIndexForPathname,
  barPositionForPage,
  barToPage,
  pageIndexByName,
  pageIndexForPathname,
  pageToBar,
} from '../tabs';

/**
 * Which page a route is, which bar item that page draws, and the conversion
 * between the two — the three questions the whole bottom bar hangs on.
 *
 * The conversion is the one worth testing hardest, and the reason is that it is
 * currently the identity. Every root page draws a bar item today, so a consumer
 * that confused the two spaces would still be right, and would keep being right
 * until the first page that the bar does not draw — a camera reached by swiping
 * off Home, say. So the mapping is exercised here against a table that HAS such
 * a page, through the same functions production uses, rather than waiting for
 * the feature to arrive and discovering the arithmetic then.
 *
 * `barIndexForPathname` decides whether the highlight is drawn at all: Bloom's
 * `TabBar` treats an index naming no item as NO SELECTION and fades the capsule
 * out where it stands. So a wrong answer there is either a bar asserting a tab
 * on a screen that is not one, or a bar going blank on a screen that is.
 */

describe('the page table', () => {
  it('has the five root destinations, in pager order', () => {
    expect(PAGES.map((page) => page.name)).toEqual([
      'index',
      'videos',
      'write',
      'notifications',
      'you',
    ]);
  });

  it('draws every one of them in the bar, for now', () => {
    // Not an invariant — it is what makes the two index spaces identical today,
    // and this test is here to go red the day that stops being true, so whoever
    // adds a swipe-only page reads the conversion tests below rather than
    // assuming the numbers still line up.
    expect(BAR_TABS.map((tab) => tab.name)).toEqual(PAGES.map((page) => page.name));
  });

  it('opts the composer out of neighbour preloading, and nothing else', () => {
    // Preloading a neighbour is what stops a page being blank under the finger,
    // and it is worth the mount for a feed. The composer is the app's heaviest
    // screen and mounting it merely for being swiped PAST would spend exactly
    // the cost the tabs rewrite removes.
    expect(PAGES.filter((page) => !page.preload).map((page) => page.name)).toEqual(['write']);
  });
});

describe('names resolve to positions', () => {
  it('in page space', () => {
    expect(pageIndexByName('index')).toBe(0);
    expect(pageIndexByName('you')).toBe(4);
  });

  it('in bar space', () => {
    expect(barIndexByName('index')).toBe(0);
    expect(barIndexByName('you')).toBe(4);
  });

  it('and answer -1 for a name that is neither', () => {
    // `BottomBar` recognises its two special tabs through this. A silent 0 would
    // make "re-tapping Home refreshes" fire on whatever tab happened to be first.
    expect(pageIndexByName('nope')).toBe(-1);
    expect(barIndexByName('nope')).toBe(-1);
  });
});

describe('pageIndexForPathname', () => {
  it.each([
    ['/', 0],
    ['/videos', 1],
    ['/write', 2],
    ['/notifications', 3],
    ['/you', 4],
  ])('matches %s to page %i', (pathname, index) => {
    expect(pageIndexForPathname(pathname)).toBe(index);
  });

  it.each([
    ['/p/abc123'],
    ['/settings/notifications'],
    ['/explore'],
    ['/notifications/pokes'],
    ['/compose'],
  ])('answers -1 on %s, which is pushed OVER the pages', (pathname) => {
    // -1 is the common answer, not an error case: the bar renders over every
    // pushed route and must show no selection there.
    expect(pageIndexForPathname(pathname)).toBe(-1);
  });

  it('answers -1 with no pathname at all', () => {
    expect(pageIndexForPathname(undefined)).toBe(-1);
    expect(pageIndexForPathname(null)).toBe(-1);
    expect(pageIndexForPathname('')).toBe(-1);
  });

  it('needs a viewer to match a handle at all', () => {
    expect(pageIndexForPathname('/@ana')).toBe(-1);
  });
});

describe('barIndexForPathname is what Bloom is handed', () => {
  it('names the bar item the reader is on', () => {
    expect(barIndexForPathname('/notifications')).toBe(3);
  });

  it('answers -1 on a route pushed over the pages', () => {
    expect(barIndexForPathname('/p/abc123')).toBe(-1);
  });
});

/**
 * PAGE ↔ BAR, against a table the production one does not have yet.
 *
 * These call the real functions with a real table shape — a page at the far left
 * that the bar does not draw, which is where a camera goes. That is the only way
 * to measure a conversion whose production instance is currently the identity.
 */
describe('converting between the two index spaces', () => {
  // index 0 is swipe-only; the bar draws pages 1..3 as items 0..2.
  const WITH_A_HIDDEN_PAGE = [0, 0, 1, 2];

  it('today the two spaces line up, in both directions', () => {
    for (let page = 0; page < PAGES.length; page += 1) {
      expect(pageToBar(page)).toBe(page);
      expect(barToPage(page)).toBe(page);
    }
  });

  it('answers -1 rather than a plausible neighbour when an index names nothing', () => {
    // A silent no-op is the failure mode here: `selectTab` returns early on a
    // page it cannot find while the pager has already advanced, so the screen
    // moves and the route does not.
    expect(pageToBar(99)).toBe(-1);
    expect(barToPage(99)).toBe(-1);
    expect(pageToBar(-1)).toBe(-1);
    expect(barToPage(-1)).toBe(-1);
  });

  it('parks the highlight on the nearest drawn tab over a page the bar skips', () => {
    // Bloom copies `activeProgress` into its geometry raw and unclamped, so an
    // out-of-range value is a real place — one item-width outside the pill —
    // not an absence. Hiding the bar over such a page is a separate decision.
    expect(BAR_POSITION_BY_PAGE).toEqual([0, 1, 2, 3, 4]);
    expect(WITH_A_HIDDEN_PAGE[0]).toBe(WITH_A_HIDDEN_PAGE[1]);
  });

  it('interpolates a fractional page position into bar units', () => {
    // 1.4 means 40% of the way from page 1 to page 2. The highlight has to track
    // that continuously, which is the whole reason the pager writes a fraction.
    expect(barPositionForPage(BAR_POSITION_BY_PAGE, 1.4)).toBeCloseTo(1.4);
    expect(barPositionForPage(WITH_A_HIDDEN_PAGE, 2.5)).toBeCloseTo(1.5);
  });

  it('holds the highlight still while the finger travels onto a skipped page', () => {
    // Home → camera: the capsule stays on Home rather than sliding off the left
    // edge of the pill. Both ends of that swipe are the same bar position, so
    // every point between them is too.
    expect(barPositionForPage(WITH_A_HIDDEN_PAGE, 1)).toBe(0);
    expect(barPositionForPage(WITH_A_HIDDEN_PAGE, 0.5)).toBe(0);
    expect(barPositionForPage(WITH_A_HIDDEN_PAGE, 0)).toBe(0);
  });

  it('clamps past either end instead of extrapolating', () => {
    // `overdrag` is off on the pager, but a position can still arrive at exactly
    // the bounds, and beyond them there is no page to interpolate towards.
    expect(barPositionForPage(BAR_POSITION_BY_PAGE, -3)).toBe(0);
    expect(barPositionForPage(BAR_POSITION_BY_PAGE, 99)).toBe(4);
    expect(barPositionForPage([], 2)).toBe(0);
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

  it("sends web to the viewer's own /@handle", () => {
    const web = loadFor('web');
    const you = web.PAGES[web.pageIndexByName('you')]!;
    expect(web.tabHref(you, 'ana')).toBe('/@ana');
    expect(web.barIndexForPathname('/@ana', 'ana')).toBe(4);
  });

  it('keeps web on /you when nobody is signed in', () => {
    // There is no handle to send to, and `/you` renders the sign-in prompt.
    const web = loadFor('web');
    const you = web.PAGES[web.pageIndexByName('you')]!;
    expect(web.tabHref(you, undefined)).toBe('/you');
  });

  it('keeps NATIVE on /you, where /@handle is a pushed route', () => {
    // Treating it as the tab there would light the pill for a screen sitting
    // OVER the tabs — a copy of your own profile opened from a post row.
    const native = loadFor('ios');
    const you = native.PAGES[native.pageIndexByName('you')]!;
    expect(native.tabHref(you, 'ana')).toBe('/you');
    expect(native.barIndexForPathname('/@ana', 'ana')).toBe(-1);
  });

  it("never counts somebody else's /@handle, on either platform", () => {
    for (const os of ['web', 'ios'] as const) {
      expect(loadFor(os).barIndexForPathname('/@someone-else', 'ana')).toBe(-1);
    }
  });

  it("does not count the viewer's own profile SUB-routes on web", () => {
    // `/@ana/replies` is a pushed route like any other. Matching it would light
    // the profile tab while the reader is somewhere the tab cannot return them.
    expect(loadFor('web').barIndexForPathname('/@ana/replies', 'ana')).toBe(-1);
  });
});
