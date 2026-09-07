import {
  BAR_POSITION_BY_PAGE,
  BAR_TABS,
  CHROME_HIDDEN_BY_PAGE,
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
 * The conversion is the one worth testing hardest, and it is no longer the
 * identity: the camera is page 0 and draws no bar item, so every bar index is
 * one less than its page index. A consumer that confuses the two now lands a tap
 * on the neighbouring screen, or parks the highlight one tab to the right of the
 * one you are on — and neither of those raises anything.
 *
 * `barIndexForPathname` decides whether the highlight is drawn at all: Bloom's
 * `TabBar` treats an index naming no item as NO SELECTION and fades the capsule
 * out where it stands. So a wrong answer there is either a bar asserting a tab
 * on a screen that is not one, or a bar going blank on a screen that is.
 */

describe('the page table', () => {
  it('has the six root pages, in pager order', () => {
    expect(PAGES.map((page) => page.name)).toEqual([
      'camera',
      'index',
      'videos',
      'write',
      'notifications',
      'you',
    ]);
  });

  it('draws five of them in the bar — the camera is swipe-only', () => {
    // This is the fact the two index spaces exist for, so it is stated rather
    // than left implicit in an arithmetic assertion further down.
    expect(BAR_TABS.map((tab) => tab.name)).toEqual([
      'index',
      'videos',
      'write',
      'notifications',
      'you',
    ]);
  });

  it('opts the composer AND the camera out of neighbour preloading', () => {
    // Preloading a neighbour is what stops a page being blank under the finger,
    // and it is worth the mount for a feed. The composer is the app's heaviest
    // screen. The camera is not a cost question at all: a mounted `CameraView`
    // holds the sensor, so being Home's neighbour would light the OS capture
    // indicator and drain the battery behind the feed.
    expect(PAGES.filter((page) => !page.preload).map((page) => page.name)).toEqual([
      'camera',
      'write',
    ]);
  });
});

describe('names resolve to positions', () => {
  it('in page space', () => {
    expect(pageIndexByName('camera')).toBe(0);
    expect(pageIndexByName('index')).toBe(1);
    expect(pageIndexByName('you')).toBe(5);
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
    ['/camera', 0],
    ['/', 1],
    ['/videos', 2],
    ['/write', 3],
    ['/notifications', 4],
    ['/you', 5],
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
  it('names the bar item the reader is on, NOT its page', () => {
    // `/notifications` is page 4 and bar item 3. Handing Bloom the page index
    // would park the capsule over the profile.
    expect(pageIndexForPathname('/notifications')).toBe(4);
    expect(barIndexForPathname('/notifications')).toBe(3);
  });

  it('answers -1 on a route pushed over the pages', () => {
    expect(barIndexForPathname('/p/abc123')).toBe(-1);
  });

  it('answers -1 on the camera, which IS a page but draws no item', () => {
    // The two -1s mean different things and this is the pair that shows it:
    // Bloom fades the highlight out either way, but only the pushed route means
    // "pop what is over the tabs". `pageIndexForPathname` is what tells them
    // apart, and `TabPagerContext` reads that one for the dismissal.
    expect(pageIndexForPathname('/camera')).toBe(0);
    expect(barIndexForPathname('/camera')).toBe(-1);
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

  it('every bar item maps back to the page it lives on', () => {
    // The camera shifts all five by one, so the round trip is the assertion:
    // an off-by-one in either direction is a tap landing on the neighbour.
    for (let bar = 0; bar < BAR_TABS.length; bar += 1) {
      expect(pageToBar(barToPage(bar))).toBe(bar);
      expect(barToPage(bar)).toBe(bar + 1);
    }
  });

  it('answers -1 for a page the bar draws no item for', () => {
    expect(pageToBar(pageIndexByName('camera'))).toBe(-1);
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
    expect(BAR_POSITION_BY_PAGE).toEqual([0, 0, 1, 2, 3, 4]);
    expect(WITH_A_HIDDEN_PAGE[0]).toBe(WITH_A_HIDDEN_PAGE[1]);
  });

  it('interpolates a fractional page position into bar units', () => {
    // 2.4 means 40% of the way from page 2 to page 3 — Videos towards the
    // composer — which the bar has to draw as 40% from item 1 to item 2. The
    // highlight tracks that continuously, which is the whole reason the pager
    // writes a fraction rather than an index.
    expect(barPositionForPage(BAR_POSITION_BY_PAGE, 2.4)).toBeCloseTo(1.4);
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

  it('holds the real highlight still over the real camera swipe', () => {
    // The production instance of the case above: Home is page 1 / bar 0, and the
    // camera is page 0 with no item. Anywhere between them the capsule stays on
    // Home instead of sliding off the left edge of the pill — Bloom does not
    // clamp what it is handed, so an unconverted 0.5 here would be half an item
    // outside it.
    expect(barPositionForPage(BAR_POSITION_BY_PAGE, 1)).toBe(0);
    expect(barPositionForPage(BAR_POSITION_BY_PAGE, 0.5)).toBe(0);
    expect(barPositionForPage(BAR_POSITION_BY_PAGE, 0)).toBe(0);
  });

  it('takes the bar away continuously as the camera comes in', () => {
    // `CHROME_HIDDEN_BY_PAGE` is the second quantity through the same
    // interpolation, which is why the bar travels WITH the finger rather than
    // popping when the page commits.
    expect(CHROME_HIDDEN_BY_PAGE).toEqual([1, 0, 0, 0, 0, 0]);
    expect(barPositionForPage(CHROME_HIDDEN_BY_PAGE, 1)).toBe(0);
    expect(barPositionForPage(CHROME_HIDDEN_BY_PAGE, 0.25)).toBeCloseTo(0.75);
    expect(barPositionForPage(CHROME_HIDDEN_BY_PAGE, 0)).toBe(1);
    // And it is back to 0 on every other page, including the far one.
    expect(barPositionForPage(CHROME_HIDDEN_BY_PAGE, 5)).toBe(0);
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
