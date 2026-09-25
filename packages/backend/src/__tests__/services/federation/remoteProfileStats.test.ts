import { describe, expect, it } from 'vitest';
import type { FederatedActorRecord } from '../../../db/federation/actorRecord';
import { remoteProfileStats, trustedRemoteCreatedAt } from '../../../services/federation/remoteProfileStats';

/**
 * What a federated profile may claim about its account (OxyHQ/Mention#1126).
 *
 * The Oxy mirror's graph and `createdAt` start the day Mention discovered the
 * actor, so the page reads the origin's totals and `published` instead — and
 * every one it cannot vouch for must come back ABSENT, never as `0`, because the
 * frontend hides an absent stat and would render a `0` as a real one.
 */
function actor(overrides: Partial<FederatedActorRecord> = {}): FederatedActorRecord {
  return {
    id: 'actor-1',
    protocol: 'activitypub',
    uri: 'https://mastodonapp.uk/users/someone',
    username: 'someone',
    domain: 'mastodonapp.uk',
    acct: 'someone@mastodonapp.uk',
    followersUrl: 'https://mastodonapp.uk/users/someone/followers',
    followingUrl: 'https://mastodonapp.uk/users/someone/following',
    type: 'Person',
    manuallyApprovesFollowers: false,
    discoverable: true,
    memorial: false,
    suspended: false,
    remoteCreatedAt: new Date('2022-11-05T00:00:00.000Z'),
    followersCount: 812,
    followingCount: 344,
    postsCount: 2048,
    lastFetchedAt: new Date('2026-09-20T00:00:00.000Z'),
    outboxBackfill: {
      status: 'idle',
      cursorItemOffset: 0,
      processedCount: 0,
      importedCount: 0,
      existingCount: 0,
      pageCount: 0,
    } as FederatedActorRecord['outboxBackfill'],
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    ...overrides,
  };
}

describe('remoteProfileStats', () => {
  it('reports the origin totals and its published date, not the discovery date', () => {
    expect(remoteProfileStats(actor())).toEqual({
      followersCount: 812,
      followingCount: 344,
      joinedAt: '2022-11-05T00:00:00.000Z',
    });
  });

  it('keeps a real zero when the collection is published', () => {
    expect(remoteProfileStats(actor({ followingCount: 0 })).followingCount).toBe(0);
  });

  it('omits a total whose collection the actor does not publish', () => {
    const stats = remoteProfileStats(actor({ followersUrl: undefined, followersCount: 0 }));
    expect(stats).not.toHaveProperty('followersCount');
    expect(stats.followingCount).toBe(344);
  });

  it('omits a total the remote withheld or that was never read (null), even with a collection URL', () => {
    const stats = remoteProfileStats(actor({ followersCount: null }));
    expect(stats).not.toHaveProperty('followersCount');
    expect(stats.followingCount).toBe(344);
  });

  it('omits a null atproto total too', () => {
    const stats = remoteProfileStats(
      actor({ protocol: 'atproto', followersUrl: undefined, followingUrl: undefined, followingCount: null }),
    );
    expect(stats.followersCount).toBe(812);
    expect(stats).not.toHaveProperty('followingCount');
  });

  it('omits both totals on a row that was never fetched', () => {
    const stats = remoteProfileStats(actor({ lastFetchedAt: undefined, followersCount: 0, followingCount: 0 }));
    expect(stats).not.toHaveProperty('followersCount');
    expect(stats).not.toHaveProperty('followingCount');
  });

  it('reports atproto totals without collection URLs', () => {
    const stats = remoteProfileStats(
      actor({ protocol: 'atproto', followersUrl: undefined, followingUrl: undefined, remoteCreatedAt: undefined }),
    );
    expect(stats).toEqual({ followersCount: 812, followingCount: 344 });
  });

  it('omits the join date when the actor published none', () => {
    expect(remoteProfileStats(actor({ remoteCreatedAt: undefined }))).not.toHaveProperty('joinedAt');
  });
});

describe('trustedRemoteCreatedAt', () => {
  const now = Date.parse('2026-09-25T00:00:00.000Z');

  it('passes a past date through', () => {
    const date = new Date('2019-01-01T00:00:00.000Z');
    expect(trustedRemoteCreatedAt(date, now)).toBe(date);
  });

  it('rejects an Invalid Date, which the column write cannot serialize', () => {
    expect(trustedRemoteCreatedAt(new Date('not a date'), now)).toBeUndefined();
  });

  it('rejects a creation date in the future', () => {
    expect(trustedRemoteCreatedAt(new Date('2027-01-01T00:00:00.000Z'), now)).toBeUndefined();
  });

  it('treats a missing date as unknown', () => {
    expect(trustedRemoteCreatedAt(undefined, now)).toBeUndefined();
  });
});
