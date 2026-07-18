import { QueryClient } from '@tanstack/react-query';

/**
 * Unit tests for the profile precache helpers, focused on the one invariant the
 * component tests can't reach: priming from a feed/list response must never
 * DOWNGRADE the viewer-relative `relationship` that the authenticated
 * single-profile fetch put on the by-username entry. That downgrade is the
 * "Follows you tag vanishes when the feed loads" bug.
 *
 * The two SDK surfaces the helper touches are ported with the EXACT key shapes
 * the real SDK uses (`@oxyhq/services` ships untranspiled TS source under jest),
 * plus a controllable active viewer. A divergence between the seed key and the
 * key `useUserByUsername` reads — e.g. re-introducing `.toLowerCase()` — would
 * fail the casing test here rather than ship silently.
 */
let mockViewerId: string | null = 'viewer-1';
jest.mock('@oxyhq/services', () => ({
  queryKeys: {
    users: {
      detail: (id: string) => ['users', 'detail', id],
      details: () => ['users', 'detail'],
    },
  },
  useAuthStore: { getState: () => ({ user: mockViewerId === null ? null : { id: mockViewerId } }) },
}));

import { precacheProfileView, type CacheableUser } from '../precacheProfiles';

/** The by-id identity key, exactly as the SDK's `useUserById` builds it. */
function detailKey(id: string): unknown[] {
  return ['users', 'detail', id];
}

/** The viewer-scoped by-username key, exactly as the SDK's `useUserByUsername` builds it. */
function usernameKey(username: string, viewerId: string): unknown[] {
  return ['users', 'detail', 'username', username, 'viewer', viewerId];
}

/** An authenticated single-profile fetch: carries the viewer `relationship`. */
function authedProfile(overrides?: Partial<CacheableUser>): CacheableUser {
  return {
    id: 'u1',
    username: 'alice',
    name: { displayName: 'Alice' },
    relationship: { isFollowing: false, followsYou: true },
    ...overrides,
  };
}

/** A feed/list user: public identity only, never a `relationship`. */
function feedUser(overrides?: Partial<CacheableUser>): CacheableUser {
  return { id: 'u1', username: 'alice', name: { displayName: 'Alice' }, ...overrides };
}

let qc: QueryClient;
beforeEach(() => {
  mockViewerId = 'viewer-1';
  qc = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
});
afterEach(() => {
  qc.clear();
});

describe('precacheProfileView — relationship preservation', () => {
  it('PRESERVES a relationship-bearing by-username entry when a feed user is primed over it', () => {
    // The profile page loaded Alice (who follows the viewer) into the cache.
    qc.setQueryData(usernameKey('alice', 'viewer-1'), authedProfile());
    const before = qc.getQueryState(usernameKey('alice', 'viewer-1'))?.dataUpdatedAt;

    // The feed loads and Alice appears as a post author — a relationship-less user.
    precacheProfileView(qc, feedUser());

    const entry = qc.getQueryData<CacheableUser>(usernameKey('alice', 'viewer-1'));
    // The "Follows you" tag survives: relationship is intact.
    expect(entry?.relationship).toEqual({ isFollowing: false, followsYou: true });
    // And the fresh authed entry was left untouched — NOT re-seeded stale (which
    // would force a needless refetch).
    expect(qc.getQueryState(usernameKey('alice', 'viewer-1'))?.dataUpdatedAt).toBe(before);
  });

  it('SEEDS an empty by-username slot as STALE so a cold navigation refetches the relationship', () => {
    precacheProfileView(qc, feedUser());

    const state = qc.getQueryState(usernameKey('alice', 'viewer-1'));
    expect(qc.getQueryData<CacheableUser>(usernameKey('alice', 'viewer-1'))?.username).toBe('alice');
    // Marked stale (updatedAt: 0) so `useUserByUsername` still fetches and pulls
    // the viewer's `relationship` on first view.
    expect(state?.dataUpdatedAt).toBe(0);
  });

  it('re-seeds over an existing relationship-LESS entry (nothing to preserve yet)', () => {
    // A prior feed pass seeded a relationship-less entry.
    precacheProfileView(qc, feedUser({ name: { displayName: 'Stale' } }));
    // A later pass with fresher identity still seeds (no relationship to protect).
    precacheProfileView(qc, feedUser({ name: { displayName: 'Fresh' } }));

    const entry = qc.getQueryData<CacheableUser>(usernameKey('alice', 'viewer-1'));
    expect(entry?.name).toEqual({ displayName: 'Fresh' });
    expect(qc.getQueryState(usernameKey('alice', 'viewer-1'))?.dataUpdatedAt).toBe(0);
  });

  it('keeps the by-id identity entry FRESH (not viewer-scoped, carries no relationship)', () => {
    precacheProfileView(qc, feedUser());

    expect(qc.getQueryData<CacheableUser>(detailKey('u1'))?.username).toBe('alice');
    // Fresh, not stale — cards read it instantly without a refetch.
    expect(qc.getQueryState(detailKey('u1'))?.dataUpdatedAt).not.toBe(0);
  });
});

describe('precacheProfileView — key casing matches the SDK exactly', () => {
  it('writes the by-username entry under the RAW username, as `useUserByUsername` reads it', () => {
    precacheProfileView(qc, feedUser({ username: 'AliceB' }));

    // The SDK hook keys on the raw `username`, so the seed must too.
    expect(qc.getQueryData<CacheableUser>(usernameKey('AliceB', 'viewer-1'))?.id).toBe('u1');
    // A lowercased key would be a phantom the hook never reads.
    expect(qc.getQueryData(usernameKey('aliceb', 'viewer-1'))).toBeUndefined();
  });

  it('scopes the seed to the active viewer, so an anon seed cannot satisfy an authed read', () => {
    mockViewerId = null; // anonymous
    precacheProfileView(qc, feedUser());

    expect(qc.getQueryData<CacheableUser>(usernameKey('alice', ''))?.id).toBe('u1');
    expect(qc.getQueryData(usernameKey('alice', 'viewer-1'))).toBeUndefined();
  });
});
