import { profileAccountFacts } from '../profileAccountFacts';

/**
 * A federated profile states its ORIGIN's join date and totals (OxyHQ/Mention#1126),
 * never the Oxy mirror's — which begin the day Mention discovered the account —
 * and hides what the origin did not report rather than showing `0`.
 */
describe('profileAccountFacts', () => {
  const mirror = {
    createdAt: '2026-09-02T10:00:00.000Z',
    _count: { followers: 0, following: 0 },
  };

  it('uses the origin figures for a federated account', () => {
    expect(
      profileAccountFacts(mirror, true, {
        followersCount: 812,
        followingCount: 344,
        joinedAt: '2022-11-05T00:00:00.000Z',
      }),
    ).toEqual({ createdAt: '2022-11-05T00:00:00.000Z', followersCount: 812, followingCount: 344 });
  });

  it('leaves unknown figures undefined for a federated account, never the mirror values', () => {
    expect(profileAccountFacts(mirror, true, { followingCount: 3 })).toEqual({
      createdAt: undefined,
      followersCount: undefined,
      followingCount: 3,
    });
  });

  it('states nothing for a federated account while its figures are still loading', () => {
    expect(profileAccountFacts(mirror, true, undefined)).toEqual({
      createdAt: undefined,
      followersCount: undefined,
      followingCount: undefined,
    });
  });

  it('keeps a local account on its own Oxy record', () => {
    expect(
      profileAccountFacts({ createdAt: '2024-01-01T00:00:00.000Z', _count: { followers: 5, following: 7 } }, false, {
        followersCount: 999,
      }),
    ).toEqual({ createdAt: '2024-01-01T00:00:00.000Z', followersCount: 5, followingCount: 7 });
  });

  it('falls back to the flat counts, then zero, for a local account', () => {
    expect(profileAccountFacts({ followersCount: 4 }, false, undefined)).toEqual({
      createdAt: undefined,
      followersCount: 4,
      followingCount: 0,
    });
  });
});
