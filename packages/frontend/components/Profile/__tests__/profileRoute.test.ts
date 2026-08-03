import type { AccountKind } from '@oxyhq/core';
import {
  canonicalProfileHref,
  profileBasePath,
  profileRouteFamilyForKind,
  profileSubPath,
  type ProfileRouteFamily,
} from '@/components/Profile/profileRoute';

/**
 * Every kind the account graph can hand back, so "a kind Oxy adds later" cannot
 * quietly acquire its own URL family by being forgotten here.
 */
const ALL_KINDS: (AccountKind | undefined)[] = [
  undefined,
  'personal',
  'organization',
  'project',
  'bot',
  'channel',
];

const FAMILIES: ProfileRouteFamily[] = ['person', 'channel'];

describe('profileRouteFamilyForKind', () => {
  it('sends a channel to the channel family', () => {
    expect(profileRouteFamilyForKind('channel')).toBe('channel');
  });

  it.each(ALL_KINDS.filter((kind) => kind !== 'channel'))(
    'sends kind %s to the person family',
    (kind) => {
      expect(profileRouteFamilyForKind(kind)).toBe('person');
    },
  );

  it('reads an absent kind as a person, never as a channel', () => {
    // Every federated and unresolved profile arrives without a kind. Reading
    // that as a channel would route the whole fediverse through `/c/`.
    expect(profileRouteFamilyForKind(undefined)).toBe('person');
  });
});

describe('profileBasePath', () => {
  it('serves a channel at /c/<handle>', () => {
    expect(profileBasePath('channel', 'news')).toBe('/c/news');
  });

  it('serves a person at /@<handle>', () => {
    expect(profileBasePath('person', 'nate')).toBe('/@nate');
  });

  it('keeps a federated handle whole', () => {
    expect(profileBasePath('person', 'nate@example.social')).toBe('/@nate@example.social');
  });
});

describe('canonicalProfileHref', () => {
  it('redirects a channel sat on the person route', () => {
    expect(
      canonicalProfileHref({
        routedFamily: 'person',
        kind: 'channel',
        handle: 'news',
        resolved: true,
      }),
    ).toBe('/c/news');
  });

  it('redirects a person sat on the channel route', () => {
    expect(
      canonicalProfileHref({
        routedFamily: 'channel',
        kind: 'personal',
        handle: 'nate',
        resolved: true,
      }),
    ).toBe('/@nate');
  });

  it('stays put when the route already matches the account', () => {
    expect(
      canonicalProfileHref({
        routedFamily: 'channel',
        kind: 'channel',
        handle: 'news',
        resolved: true,
      }),
    ).toBeNull();
    expect(
      canonicalProfileHref({
        routedFamily: 'person',
        kind: 'personal',
        handle: 'nate',
        resolved: true,
      }),
    ).toBeNull();
  });

  // The account's kind is only knowable once it has resolved. Redirecting on a
  // guess would bounce every channel through `/@` on each cold load, and the
  // reader would watch it happen.
  it('does not redirect before the account resolves', () => {
    expect(
      canonicalProfileHref({
        routedFamily: 'person',
        kind: undefined,
        handle: 'news',
        resolved: false,
      }),
    ).toBeNull();
  });

  it('does not redirect without a handle to redirect to', () => {
    expect(
      canonicalProfileHref({
        routedFamily: 'channel',
        kind: 'personal',
        handle: '',
        resolved: true,
      }),
    ).toBeNull();
  });

  /**
   * THE property this module exists for.
   *
   * Two screens each deciding where to send a reader is how a bounce loop gets
   * built: `/c/x` sends to `/@x`, `/@x` sends back, and the browser spins. One
   * shared rule makes that impossible, and this is the assertion that says so —
   * following the redirect ONCE must always land somewhere that redirects no
   * further, for every combination of arrival route and account kind.
   */
  it('reaches a fixed point in one hop, from every route and every kind', () => {
    for (const routedFamily of FAMILIES) {
      for (const kind of ALL_KINDS) {
        const first = canonicalProfileHref({
          routedFamily,
          kind,
          handle: 'acct',
          resolved: true,
        });
        if (first === null) continue;

        // Where the redirect actually landed the reader, read off the URL rather
        // than assumed — that is the whole point of following it.
        const landedFamily: ProfileRouteFamily = String(first).startsWith('/c/')
          ? 'channel'
          : 'person';
        const second = canonicalProfileHref({
          routedFamily: landedFamily,
          kind,
          handle: 'acct',
          resolved: true,
        });
        expect(second).toBeNull();
      }
    }
  });

  // A vacuity floor for the loop test above: if `canonicalProfileHref` ever
  // returned null for everything, the loop would pass by never redirecting at
  // all. Exactly half the (family × kind) grid must redirect — one family is
  // always wrong for any given kind.
  it('actually redirects half the grid, so the fixed-point test is not vacuous', () => {
    const redirects = FAMILIES.flatMap((routedFamily) =>
      ALL_KINDS.map((kind) =>
        canonicalProfileHref({ routedFamily, kind, handle: 'acct', resolved: true }),
      ),
    ).filter((href) => href !== null);

    expect(redirects).toHaveLength(ALL_KINDS.length);
  });
});

describe('profileSubPath', () => {
  it('serves a channel sub-surface under /c/', () => {
    expect(profileSubPath('channel', 'news', 'about')).toBe('/c/news/about');
  });

  it('serves a person sub-surface under /@', () => {
    expect(profileSubPath('person', 'nate', 'about')).toBe('/@nate/about');
  });
});

describe('canonicalProfileHref — sub-routes', () => {
  it('carries the sub-surface across the redirect, both ways', () => {
    // Dropping it would land the reader at the top of a profile they were
    // already looking at, which reads as a dead link rather than a redirect.
    expect(
      canonicalProfileHref({
        routedFamily: 'person',
        kind: 'channel',
        handle: 'news',
        resolved: true,
        subpath: 'about',
      }),
    ).toBe('/c/news/about');
    expect(
      canonicalProfileHref({
        routedFamily: 'channel',
        kind: 'personal',
        handle: 'nate',
        resolved: true,
        subpath: 'about',
      }),
    ).toBe('/@nate/about');
  });

  it('stays put on the right family, sub-route included', () => {
    expect(
      canonicalProfileHref({
        routedFamily: 'channel',
        kind: 'channel',
        handle: 'news',
        resolved: true,
        subpath: 'about',
      }),
    ).toBeNull();
  });

  /**
   * The same fixed-point property as the profile root, now that sub-routes have
   * widened the surface. A sub-route redirecting to its counterpart is exactly
   * the shape that can ping-pong, since BOTH ends now exist and both are
   * legitimately reachable.
   */
  it('reaches a fixed point in one hop for a sub-route too', () => {
    let redirects = 0;
    for (const routedFamily of FAMILIES) {
      for (const kind of ALL_KINDS) {
        const first = canonicalProfileHref({
          routedFamily,
          kind,
          handle: 'acct',
          resolved: true,
          subpath: 'about',
        });
        if (first === null) continue;
        redirects += 1;
        expect(String(first).endsWith('/about')).toBe(true);

        const landedFamily: ProfileRouteFamily = String(first).startsWith('/c/')
          ? 'channel'
          : 'person';
        expect(
          canonicalProfileHref({
            routedFamily: landedFamily,
            kind,
            handle: 'acct',
            resolved: true,
            subpath: 'about',
          }),
        ).toBeNull();
      }
    }
    // Vacuity floor, same as the root case.
    expect(redirects).toBe(ALL_KINDS.length);
  });
});
