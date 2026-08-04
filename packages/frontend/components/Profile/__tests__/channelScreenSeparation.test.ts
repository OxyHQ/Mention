import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND = join(__dirname, '..', '..', '..');

// Production source only. Tests are excluded because a check that names the
// identifier it forbids would otherwise match itself — and because a test is
// allowed to talk about code that no longer exists.
const SKIPPED_DIRS = new Set(['node_modules', '.expo', 'dist', '__tests__', '__mocks__']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(join(FRONTEND, 'components')).concat(
  walk(join(FRONTEND, 'app')),
  walk(join(FRONTEND, 'hooks')),
);

function read(...segments: string[]): string {
  return readFileSync(join(FRONTEND, ...segments), 'utf8');
}

/**
 * Source with comments removed.
 *
 * A grep for a removed identifier has to distinguish USING it from RECORDING
 * that it is gone — the docstrings that explain why `minimalistMode` was
 * deleted name it, and a check that cannot tell those apart either fires on
 * every honest explanation or forces the explanations out of the code.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * A channel's page and a person's page are two SCREENS, not one screen with
 * conditions. These assertions pin the parts of that separation that a future
 * edit could quietly undo — each one names a defect that was reported, so a
 * failure here says which symptom is coming back.
 */
describe('channel and person profiles are separate screens', () => {
  // Vacuity floor: a broken walk would make every "does not contain" assertion
  // below pass by scanning nothing.
  it('scanned a plausible number of source files', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(300);
  });

  /**
   * DEFECT: the poke button appeared on a channel.
   *
   * A poke is addressed to a person, and `isActAsEligibleKind` refuses
   * `channel`, so nobody is ever signed in as one to receive it. The fix is
   * structural: the channel's header components do not render a poke, so there
   * is no flag to get wrong and no `isChannel` prop threaded through a shared
   * component to forget at a call site.
   */
  it('never reaches the poke from the channel screen', () => {
    const channelSources = [
      read('components', 'ChannelScreen.tsx'),
      read('components', 'Profile', 'ChannelHeader.tsx'),
    ];
    for (const source of channelSources) {
      expect(code(source)).not.toMatch(/\busePoke\b/);
    }
  });

  it('keeps the poke on the person header, so the check above is not vacuous', () => {
    // Without this, deleting the poke everywhere would satisfy the assertion
    // above while removing the feature.
    expect(read('components', 'Profile', 'ProfileHeader.tsx')).toMatch(/usePoke/);
  });

  it('imports usePoke from exactly one component', () => {
    const importers = SOURCE_FILES.filter((file) =>
      /from '\.\/hooks\/usePoke'|from '@\/components\/Profile\/hooks\/usePoke'/.test(
        readFileSync(file, 'utf8'),
      ),
    ).map((f) => f.slice(FRONTEND.length + 1));

    expect(importers).toEqual([join('components', 'Profile', 'ProfileHeader.tsx')]);
  });

  /**
   * The canonicalization between `/@` and `/c/` is the ONE piece that cannot be
   * duplicated: two screens each deciding where to redirect can build a bounce
   * loop between them. Every profile screen must reach it through the shared
   * helper.
   *
   * The person profile is TWO files since the web build split its chrome into
   * the tab group's layout, so a screen may reach `useProfileAccount` either
   * directly or through `usePersonProfileView`, which calls it once for both.
   * Which of the two it is, is asserted rather than allowed to be neither.
   */
  const PROFILE_SCREENS = [
    ['ProfileScreen.tsx'],
    ['ProfileScreen.web.tsx'],
    ['ChannelScreen.tsx'],
  ];

  it('routes every profile screen through the one canonicalization', () => {
    const shared = code(read('components', 'Profile', 'hooks', 'usePersonProfileView.tsx'));
    expect(shared).toMatch(/useProfileAccount\('person'\)/);

    for (const screen of PROFILE_SCREENS) {
      const source = code(read('components', ...screen));
      const reachesAccount =
        /useProfileAccount\(/.test(source) || /usePersonProfileView/.test(source);
      expect({ screen: screen.join('/'), reachesAccount }).toEqual({
        screen: screen.join('/'),
        reachesAccount: true,
      });
      expect(source).toMatch(/canonicalHref/);
      // A screen that builds its own redirect target has left the shared rule.
      expect(source).not.toMatch(/<Redirect href={`/);
    }
  });

  /**
   * The tab group's LAYOUT must not redirect, however wrong the URL family is.
   *
   * A layout has to render its navigator unconditionally — a `<Redirect/>`
   * renders null, which leaves the segment with no navigator in the navigation
   * state and, on web, sends the remount that follows chasing `usePathname()`
   * until React aborts the render (`[username]/_layout.tsx` carries the full
   * account). It holds the skeleton instead and lets the SCREEN below redirect,
   * which is the one place that is allowed to.
   */
  it('leaves the redirect to the screen, never the tab layout', () => {
    const layout = code(read('components', 'Profile', 'ProfileTabsChrome.web.tsx'));
    expect(layout).not.toMatch(/<Redirect/);
    // Not vacuous: it does read the shared verdict, it just does not act on it
    // by unmounting the navigator.
    expect(layout).toMatch(/canonicalHref/);
    expect(layout).toMatch(/<Slot \/>/);
  });

  /**
   * `design.minimalistMode` was a LAYOUT name for an account fact — it was
   * defined as `kind === 'channel'` — and selecting the header off it is what
   * made the two screens one. It is gone; nothing should reintroduce it.
   */
  it('has no minimalistMode flag left anywhere', () => {
    const offenders = SOURCE_FILES.filter((file) =>
      /\bminimalistMode\b/.test(code(readFileSync(file, 'utf8'))),
    ).map((f) => f.slice(FRONTEND.length + 1));

    expect(offenders).toEqual([]);
  });

  /**
   * DEFECT: rows on a channel page opened person-shaped URLs.
   *
   * The shared rows (joined date, follower/following counts) must not build a
   * URL family of their own — they are rendered by both screens and cannot know
   * which one they are on. Each takes an explicit href instead.
   */
  it('keeps the URL family out of the shared meta and stats rows', () => {
    for (const row of ['ProfileMeta.tsx', 'ProfileStats.tsx']) {
      const source = code(read('components', 'Profile', row));
      expect(source).not.toMatch(/`\/@\$\{/);
      expect(source).not.toMatch(/`\/c\/\$\{/);
    }
  });
});

/**
 * DEFECT: a channel's "Joined <date>" row opened the PERSON family's about page.
 *
 * `/@<channel-handle>/about` renders perfectly well — the about screen never
 * reads the account kind — which is exactly why this was silent. The account was
 * simply sitting on a URL it does not own.
 */
describe('a channel has its own about page', () => {
  it('routes the channel profile at its own about, not the person family\'s', () => {
    const source = code(read('components', 'ChannelScreen.tsx'));
    expect(source).toMatch(/aboutHref=\{`\/c\/\$\{handle\}\/about`\}/);
    expect(source).not.toMatch(/aboutHref=\{`\/@/);
  });

  it('keeps the person profile on the person family, so the check is not vacuous', () => {
    // The person's summary is built by the hook both platforms share, so that
    // is where its hrefs are now written.
    const source = code(read('components', 'Profile', 'hooks', 'usePersonProfileView.tsx'));
    expect(source).toMatch(/aboutHref=\{`\/@\$\{handle\}\/about`\}/);
  });

  it('serves both routes from ONE screen component', () => {
    // Two implementations of "what is this account" is two places for the
    // identity rules to drift, which is the whole reason the profile screens
    // share their primitives rather than their code being copied.
    for (const route of [
      join('app', '(app)', '[username]', 'about.tsx'),
      join('app', '(app)', 'c', '[username]', 'about.tsx'),
    ]) {
      const source = readFileSync(join(FRONTEND, route), 'utf8');
      expect(source).toMatch(/from '@\/components\/AccountInfoScreen'/);
    }
    // And each declares which family it is, rather than sniffing the pathname.
    expect(readFileSync(join(FRONTEND, 'app', '(app)', 'c', '[username]', 'about.tsx'), 'utf8'))
      .toMatch(/routedFamily="channel"/);
    expect(readFileSync(join(FRONTEND, 'app', '(app)', '[username]', 'about.tsx'), 'utf8'))
      .toMatch(/routedFamily="person"/);
  });

  it('canonicalizes the about page through the SAME shared rule as the profiles', () => {
    // A sub-route is where a bounce loop becomes possible: both ends exist and
    // both are reachable, so a second opinion about which way to send would be
    // a real loop rather than a wasted hop.
    const source = code(read('components', 'AccountInfoScreen.tsx'));
    expect(source).toMatch(/useProfileAccount\(/);
    expect(source).toMatch(/canonicalHref/);
    expect(source).not.toMatch(/<Redirect href={`/);
  });
});

/**
 * The channel page's OPERATOR rows.
 *
 * A channel is never anybody's "own profile" — no session's subject can be one —
 * so it gets none of the header cluster a person has, and everything about
 * RUNNING the account lives in the overflow menu instead. Two properties of those
 * rows are worth pinning, because nothing else in the toolchain checks either.
 */
describe('a channel’s operator rows', () => {
  const CHANNEL_ROUTE_DIR = join(FRONTEND, 'app', '(app)', 'c', '[username]');
  const channelScreen = code(read('components', 'ChannelScreen.tsx'));
  const targets = [...channelScreen.matchAll(/`\/c\/\$\{handle\}\/([a-z_-]+)`/g)].map((m) => m[1]);

  it('points every operator row at a route that EXISTS', () => {
    // `typedRoutes` is on and INERT on this expo-router major: `router.push` of a
    // route that was never created type-checks, builds and ships, failing only
    // under a user's thumb as "This screen does not exist." A file check is the
    // only thing standing between a typo here and that.
    expect(targets.length).toBeGreaterThanOrEqual(2); // vacuity floor: the regex still matches
    for (const segment of new Set(targets)) {
      expect(readdirSync(CHANNEL_ROUTE_DIR)).toContain(`${segment}.tsx`);
    }
  });

  it('offers insights only to somebody who operates the channel', () => {
    // Affordance ⊆ permission. The server refuses a non-operator's read of a
    // private dashboard, so the row must never be rendered for one — and the one
    // gate that decides it is `operatesThisChannel`, shared with the settings row
    // beside it.
    const gated = channelScreen.slice(
      channelScreen.indexOf('const leadingActions'),
      channelScreen.indexOf('[operatesThisChannel, handle, t]'),
    );
    expect(gated).toContain('operatesThisChannel');
    expect(gated).toMatch(/`\/c\/\$\{handle\}\/insights`/);
    // …and nowhere else, so no ungated caller can reintroduce it.
    expect(channelScreen.match(/`\/c\/\$\{handle\}\/insights`/g)).toHaveLength(1);
  });
});
