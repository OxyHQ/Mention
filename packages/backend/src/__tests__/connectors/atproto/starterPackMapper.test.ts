import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * atproto starter-pack mirroring.
 *
 *  - `extractStarterPackRefs` / `extractMemberDids`: pure extraction from the
 *    AppView `getActorStarterPacks` / `getList` shapes (filtering + caps).
 *  - `syncActorStarterPacks`: getActorStarterPacks → getList members → resolve each
 *    member DID to an Oxy user (the shared profile path) → upsert a `StarterPack`
 *    deduped on `source.uri`. The XRPC fetch, the StarterPack model, and the member
 *    profile resolver are mocked; the real bounded-concurrency pool runs.
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  findOneAndUpdate: vi.fn(),
  fetchProfile: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

vi.mock('../../../models/StarterPack', () => ({
  default: { findOneAndUpdate: mocks.findOneAndUpdate },
}));

vi.mock('../../../connectors/atproto/profile.mapper', () => ({
  fetchAndUpsertAtprotoProfile: mocks.fetchProfile,
}));

import {
  extractMemberDids,
  extractStarterPackRefs,
  syncActorStarterPacks,
} from '../../../connectors/atproto/starterpack.mapper';

const DID = 'did:plc:owner0000000000000000000';
const OWNER = 'oxy-owner';

function packUri(rkey: string): string {
  return `at://${DID}/app.bsky.graph.starterpack/${rkey}`;
}
function listUri(rkey: string): string {
  return `at://${DID}/app.bsky.graph.list/${rkey}`;
}

/** Route the mocked XRPC by nsid so one mock serves both endpoints. */
function routeXrpc(
  handlers: { starterPacks?: unknown; list?: Record<string, unknown> },
): void {
  mocks.xrpcGet.mockImplementation((_host: string, nsid: string, params: Record<string, unknown>) => {
    if (nsid === 'app.bsky.graph.getActorStarterPacks') return Promise.resolve(handlers.starterPacks ?? { starterPacks: [] });
    if (nsid === 'app.bsky.graph.getList') {
      const list = typeof params.list === 'string' ? params.list : '';
      return Promise.resolve(handlers.list?.[list] ?? { items: [] });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOneAndUpdate.mockResolvedValue({ _id: 'pack-doc' });
  mocks.fetchProfile.mockImplementation((did: string) =>
    Promise.resolve({ network: 'atproto', externalId: did, handle: `${did}.h`, oxyUserId: `oxy-${did.slice(-2)}` }),
  );
});

describe('extractStarterPackRefs', () => {
  it('keeps packs with a valid uri + name + list ref, drops the rest', () => {
    const refs = extractStarterPackRefs({
      starterPacks: [
        { uri: packUri('p1'), record: { name: 'Great moots', list: listUri('l1') } },
        { uri: packUri('p2'), record: { name: '   ', list: listUri('l2') } }, // blank name
        { uri: packUri('p3'), record: { name: 'No list' } }, // missing list
        { uri: `at://${DID}/app.bsky.feed.post/x`, record: { name: 'Wrong collection', list: listUri('l4') } },
        { record: { name: 'No uri', list: listUri('l5') } }, // missing uri
      ],
    });
    expect(refs).toEqual([{ uri: packUri('p1'), name: 'Great moots', listUri: listUri('l1') }]);
  });

  it('returns [] for an empty / malformed response', () => {
    expect(extractStarterPackRefs(undefined)).toEqual([]);
    expect(extractStarterPackRefs({})).toEqual([]);
    expect(extractStarterPackRefs({ starterPacks: [] })).toEqual([]);
  });
});

describe('extractMemberDids', () => {
  it('pulls subject DIDs in order and dedups', () => {
    expect(
      extractMemberDids({
        items: [
          { subject: { did: 'did:plc:a' } },
          { subject: { did: 'did:plc:b' } },
          { subject: { did: 'did:plc:a' } }, // dup
          { subject: {} }, // no did
        ],
      }),
    ).toEqual(['did:plc:a', 'did:plc:b']);
  });
});

describe('syncActorStarterPacks', () => {
  it('mirrors a pack to a StarterPack with resolved members, keyed on source.uri', async () => {
    routeXrpc({
      starterPacks: { starterPacks: [{ uri: packUri('p1'), record: { name: 'Great moots', list: listUri('l1') } }] },
      list: {
        [listUri('l1')]: {
          items: [{ subject: { did: 'did:plc:m1' } }, { subject: { did: 'did:plc:m2' } }],
        },
      },
    });
    mocks.fetchProfile.mockImplementation((did: string) => {
      const map: Record<string, string> = { 'did:plc:m1': 'oxy-m1', 'did:plc:m2': 'oxy-m2' };
      return Promise.resolve(map[did] ? { network: 'atproto', externalId: did, handle: 'h', oxyUserId: map[did] } : null);
    });

    const count = await syncActorStarterPacks(DID, OWNER);

    expect(count).toBe(1);
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ 'source.uri': packUri('p1') });
    expect(options).toEqual({ upsert: true });
    expect(update.$set).toMatchObject({
      ownerOxyUserId: OWNER,
      name: 'Great moots',
      memberOxyUserIds: ['oxy-m1', 'oxy-m2'],
    });
    expect(update.$set.source).toMatchObject({ network: 'atproto', uri: packUri('p1') });
    expect(update.$set.source.syncedAt).toBeInstanceOf(Date);
  });

  it('drops members that do not resolve to an Oxy user (no orphan members)', async () => {
    routeXrpc({
      starterPacks: { starterPacks: [{ uri: packUri('p1'), record: { name: 'Pack', list: listUri('l1') } }] },
      list: {
        [listUri('l1')]: {
          items: [{ subject: { did: 'did:plc:ok' } }, { subject: { did: 'did:plc:ghost' } }],
        },
      },
    });
    mocks.fetchProfile.mockImplementation((did: string) =>
      did === 'did:plc:ok'
        ? Promise.resolve({ network: 'atproto', externalId: did, handle: 'h', oxyUserId: 'oxy-ok' })
        : Promise.resolve(null),
    );

    await syncActorStarterPacks(DID, OWNER);

    expect(mocks.findOneAndUpdate.mock.calls[0][1].$set.memberOxyUserIds).toEqual(['oxy-ok']);
  });

  it('resolves each DISTINCT member DID once even when shared across packs', async () => {
    routeXrpc({
      starterPacks: {
        starterPacks: [
          { uri: packUri('p1'), record: { name: 'A', list: listUri('l1') } },
          { uri: packUri('p2'), record: { name: 'B', list: listUri('l2') } },
        ],
      },
      list: {
        [listUri('l1')]: { items: [{ subject: { did: 'did:plc:shared' } }] },
        [listUri('l2')]: { items: [{ subject: { did: 'did:plc:shared' } }] },
      },
    });
    mocks.fetchProfile.mockResolvedValue({ network: 'atproto', externalId: 'did:plc:shared', handle: 'h', oxyUserId: 'oxy-shared' });

    await syncActorStarterPacks(DID, OWNER);

    // Two packs upserted, but the shared member resolved only once.
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.fetchProfile).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a re-sync upserts on the same source.uri, never creating a duplicate', async () => {
    routeXrpc({
      starterPacks: { starterPacks: [{ uri: packUri('p1'), record: { name: 'Pack', list: listUri('l1') } }] },
      list: { [listUri('l1')]: { items: [{ subject: { did: 'did:plc:m1' } }] } },
    });
    mocks.fetchProfile.mockResolvedValue({ network: 'atproto', externalId: 'did:plc:m1', handle: 'h', oxyUserId: 'oxy-m1' });

    await syncActorStarterPacks(DID, OWNER);
    await syncActorStarterPacks(DID, OWNER);

    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(2);
    // Both runs target the same document via the source-uri dedup key + upsert.
    for (const call of mocks.findOneAndUpdate.mock.calls) {
      expect(call[0]).toEqual({ 'source.uri': packUri('p1') });
      expect(call[2]).toEqual({ upsert: true });
    }
  });

  it('no-ops without a resolved Oxy owner (no orphan packs) and never fetches', async () => {
    const count = await syncActorStarterPacks(DID, '');
    expect(count).toBe(0);
    expect(mocks.xrpcGet).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('fails soft when getActorStarterPacks throws', async () => {
    mocks.xrpcGet.mockRejectedValue(new Error('appview 502'));
    const count = await syncActorStarterPacks(DID, OWNER);
    expect(count).toBe(0);
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
