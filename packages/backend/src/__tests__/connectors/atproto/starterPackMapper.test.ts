import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';

/**
 * atproto starter-pack mirroring.
 *
 *  - `extractStarterPackRefs` / `extractMemberDids`: pure extraction from the
 *    AppView `getActorStarterPacks` / `getList` shapes (filtering + caps).
 *  - `syncActorStarterPacks`: getActorStarterPacks → getList members → resolve each
 *    member DID to an Oxy user (the shared profile path) → upsert a `StarterPack`
 *    deduped on its source URI. The XRPC fetch and the member profile resolver
 *    are mocked — both are network calls to another service — and the real
 *    bounded-concurrency pool runs.
 *
 * The PACKS are real Postgres rows. They used to be a mocked
 * `StarterPack.findOneAndUpdate` whose assertions were call shapes: that it was
 * invoked twice, with `{'source.uri': …}` and `{upsert: true}`. That cannot
 * distinguish a mirror that works from one writing to a store nothing reads,
 * which is exactly what it was doing — every reader had moved to `starter_packs`
 * while the mirror still upserted Mongo, so mirrored packs never appeared in the
 * API and never curated anything. Asserting the ROWS is what makes the
 * idempotence claim mean "one pack after two syncs" instead of "two calls".
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  fetchProfile: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

vi.mock('../../../connectors/atproto/profile.mapper', () => ({
  fetchAndUpsertAtprotoProfile: mocks.fetchProfile,
}));

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { starterPackMembers, starterPacks } from '../../../db/schema/lists';
import {
  extractMemberDids,
  extractStarterPackRefs,
  syncActorStarterPacks,
} from '../../../connectors/atproto/starterpack.mapper';

const DID = 'did:plc:owner0000000000000000000';
// Scoped to this file: `starter_packs` is one table shared by every parallel suite.
const OWNER = 'oxy-spm-owner';

/** Every mirrored pack this file created, newest membership first. */
async function packsOf(owner = OWNER) {
  return getDb()
    .select({ id: starterPacks.id, name: starterPacks.name, sourceUri: starterPacks.sourceUri })
    .from(starterPacks)
    .where(eq(starterPacks.ownerOxyUserId, owner))
    .orderBy(asc(starterPacks.sourceUri));
}

async function membersOf(packId: string) {
  return getDb()
    .select({ oxyUserId: starterPackMembers.oxyUserId })
    .from(starterPackMembers)
    .where(eq(starterPackMembers.packId, packId))
    .orderBy(asc(starterPackMembers.position));
}

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

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // `starter_pack_members` cascades from `starter_packs`.
  await getDb().delete(starterPacks).where(eq(starterPacks.ownerOxyUserId, OWNER));
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
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
    const [pack] = await packsOf();
    expect(pack?.name).toBe('Great moots');
    expect(pack?.sourceUri).toBe(packUri('p1'));
    // Membership IN UPSTREAM ORDER: `position` is what preserves it, and a set
    // comparison would pass against a mirror that scrambled the pack.
    expect((await membersOf(pack.id)).map((m) => m.oxyUserId)).toEqual(['oxy-m1', 'oxy-m2']);
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

    const [pack] = await packsOf();
    expect((await membersOf(pack.id)).map((m) => m.oxyUserId)).toEqual(['oxy-ok']);
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

    // Two packs stored, but the shared member resolved only once.
    expect(await packsOf()).toHaveLength(2);
    expect(mocks.fetchProfile).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a re-sync updates the same pack and REPLACES its members', async () => {
    // The membership CHANGES between the two syncs, and that is the whole point.
    // Re-syncing identical members cannot detect a missing replacement: the
    // second insert just collides on `(pack_id, oxy_user_id)`, the mapper's
    // fail-soft catch swallows it, and the rows left behind are the correct ones
    // from the first run. Measured — a version of this case that synced
    // `['oxy-m1']` twice passed with the DELETE removed from the repository.
    //
    // Dropping a member is the case that discriminates: without the delete,
    // `oxy-gone` survives a sync that no longer lists it.
    const members = { first: ['did:plc:m1', 'did:plc:gone'], second: ['did:plc:m1'] };
    let phase: 'first' | 'second' = 'first';
    mocks.xrpcGet.mockImplementation((_host: string, nsid: string, params: Record<string, unknown>) => {
      if (nsid === 'app.bsky.graph.getActorStarterPacks') {
        return Promise.resolve({
          starterPacks: [{ uri: packUri('p1'), record: { name: 'Pack', list: listUri('l1') } }],
        });
      }
      if (nsid === 'app.bsky.graph.getList' && params.list === listUri('l1')) {
        return Promise.resolve({ items: members[phase].map((did) => ({ subject: { did } })) });
      }
      return Promise.resolve({});
    });
    mocks.fetchProfile.mockImplementation((did: string) =>
      Promise.resolve({ network: 'atproto', externalId: did, handle: 'h', oxyUserId: `oxy-${did.split(':').pop()}` }),
    );

    await syncActorStarterPacks(DID, OWNER);
    expect((await membersOf((await packsOf())[0].id)).map((m) => m.oxyUserId))
      .toEqual(['oxy-m1', 'oxy-gone']);

    phase = 'second';
    await syncActorStarterPacks(DID, OWNER);

    // One pack, and the dropped member is GONE rather than left behind.
    const packs = await packsOf();
    expect(packs).toHaveLength(1);
    expect((await membersOf(packs[0].id)).map((m) => m.oxyUserId)).toEqual(['oxy-m1']);
  });

  it('no-ops without a resolved Oxy owner (no orphan packs) and never fetches', async () => {
    const count = await syncActorStarterPacks(DID, '');
    expect(count).toBe(0);
    expect(mocks.xrpcGet).not.toHaveBeenCalled();
    expect(await packsOf('')).toHaveLength(0);
  });

  it('fails soft when getActorStarterPacks throws', async () => {
    mocks.xrpcGet.mockRejectedValue(new Error('appview 502'));
    const count = await syncActorStarterPacks(DID, OWNER);
    expect(count).toBe(0);
    expect(await packsOf()).toHaveLength(0);
  });
});
