/**
 * Account lists are REAL rows here; starter packs are still mocked.
 *
 * The difference is which store each one lives in. `AccountList` moved to
 * Postgres and nothing writes the Mongo collection any more, so a mocked
 * `AccountList.findById` was intercepting an import the service no longer
 * performs — and the case that matters most (`null` means DELETED, so the caller
 * RETRACTS endorsements) would have been proven against a fake.
 *
 * `StarterPack` is real rows too now. Its last Mongo writer was the atproto
 * mirror, which moved to `starter_packs` — so that mock had also stopped
 * intercepting anything.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  outboxUpdateOne: vi.fn(),
  outboxFindOne: vi.fn(),
  outboxFind: vi.fn(),
  outboxDeleteOne: vi.fn(),
  pushEndorsements: vi.fn(),
}));


vi.mock('../../models/EndorsementOutbox', () => ({
  default: {
    updateOne: mocks.outboxUpdateOne,
    findOne: mocks.outboxFindOne,
    find: mocks.outboxFind,
    deleteOne: mocks.outboxDeleteOne,
  },
  getEndorsementNextAttempt: (attempts: number) => new Date(1000 + attempts),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  accountListMembers,
  accountLists,
  starterPackMembers,
  starterPacks,
} from '../../db/schema/lists';
import { EndorsementSignalService } from '../../services/EndorsementSignalService';

/** List ids this file created, so teardown never touches another suite's rows. */
const seededListIds: string[] = [];
/** Same, for starter packs. */
const seededPackIds: string[] = [];

/** Insert a real starter pack plus its ordered members; returns the generated id. */
async function seedPack(ownerId: string, memberIds: string[]): Promise<string> {
  const [pack] = await getDb()
    .insert(starterPacks)
    .values({ ownerOxyUserId: ownerId, name: 'endorsement fixture' })
    .returning({ id: starterPacks.id });
  seededPackIds.push(pack.id);
  if (memberIds.length > 0) {
    await getDb().insert(starterPackMembers).values(
      memberIds.map((oxyUserId, position) => ({ packId: pack.id, oxyUserId, position })),
    );
  }
  return pack.id;
}

/** Insert a real list plus its ordered members; returns the generated id. */
async function seedList(ownerId: string, memberIds: string[]): Promise<string> {
  const [list] = await getDb()
    .insert(accountLists)
    .values({ ownerOxyUserId: ownerId, title: 'endorsement fixture' })
    .returning({ id: accountLists.id });
  seededListIds.push(list.id);
  if (memberIds.length > 0) {
    await getDb().insert(accountListMembers).values(
      memberIds.map((oxyUserId, position) => ({ listId: list.id, oxyUserId, position })),
    );
  }
  return list.id;
}

/** `findById(...).select(...).lean()` chain returning `doc`. */
function findByIdLean(doc: unknown) {
  return vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) }),
  });
}

const signalsClient = { pushEndorsements: mocks.pushEndorsements, pushInterests: vi.fn() };

function makeService() {
  return new EndorsementSignalService(signalsClient as unknown as never);
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  if (seededListIds.length === 0 && seededPackIds.length === 0) return;
  // `accountListMembers` cascades from `accountLists`, so one delete is enough.
  await getDb().delete(accountLists).where(inArray(accountLists.id, seededListIds));
  seededListIds.length = 0;
  if (seededPackIds.length > 0) {
    await getDb().delete(starterPacks).where(inArray(starterPacks.id, seededPackIds));
    seededPackIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.outboxUpdateOne.mockResolvedValue({});
  mocks.outboxFindOne.mockReturnValue({
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  });
  mocks.outboxDeleteOne.mockResolvedValue({ catch: vi.fn() });
  mocks.outboxDeleteOne.mockReturnValue(Promise.resolve({}));
  mocks.pushEndorsements.mockResolvedValue(undefined);
});

describe('EndorsementSignalService.syncScope', () => {
  it('pushes the CURRENT member set as add edges (owner→members, self excluded) and marks sent', async () => {
    // `owner` and the duplicate `m1` are deliberately absent from the ROWS: a
    // starter pack's membership is `unique(pack_id, oxy_user_id)`, so the
    // de-duplication the old fixture exercised in memory cannot occur in the
    // store. What the service must still do is exclude the OWNER from its own
    // edges, which the seed below leaves it free to get wrong.
    const packId = await seedPack('owner', ['m1', 'm2', 'owner']);

    const service = makeService();
    await service.syncScope('starterPack', packId);

    expect(mocks.pushEndorsements).toHaveBeenCalledTimes(1);
    const edges = mocks.pushEndorsements.mock.calls[0][0];
    expect(edges).toEqual([
      { ownerId: 'owner', memberId: 'm1', op: 'add', sourceId: packId },
      { ownerId: 'owner', memberId: 'm2', op: 'add', sourceId: packId },
    ]);

    // Armed pending first, then marked sent.
    const setSent = mocks.outboxUpdateOne.mock.calls.find(
      (c) => c[1]?.$set?.status === 'sent',
    );
    expect(setSent).toBeDefined();
  });

  it('is idempotent — re-running pushes the same edges again', async () => {
    const packId = await seedPack('owner', ['m1']);

    const service = makeService();
    await service.syncScope('starterPack', packId);
    await service.syncScope('starterPack', packId);

    expect(mocks.pushEndorsements).toHaveBeenCalledTimes(2);
    expect(mocks.pushEndorsements.mock.calls[0][0]).toEqual(mocks.pushEndorsements.mock.calls[1][0]);
  });

  it('leaves the outbox row PENDING with backoff when Oxy is down', async () => {
    const listId = await seedList('owner', ['m1']);
    mocks.pushEndorsements.mockRejectedValue(new Error('oxy down'));
    mocks.outboxFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ attempts: 0 }) }),
    });

    const service = makeService();
    await service.syncScope('accountList', listId);

    const failUpdate = mocks.outboxUpdateOne.mock.calls.find(
      (c) => c[1]?.$set?.status === 'pending' && typeof c[1]?.$set?.attempts === 'number',
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate?.[1].$set.attempts).toBe(1);
    expect(failUpdate?.[1].$set.error).toBe('oxy down');
    // Never marked sent.
    const setSent = mocks.outboxUpdateOne.mock.calls.find((c) => c[1]?.$set?.status === 'sent');
    expect(setSent).toBeUndefined();
  });

  it('retries pending remove edges captured from an earlier failed membership change', async () => {
    const listId = await seedList('owner', ['keep']);
    mocks.outboxFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          pendingRemoveOwnerId: 'owner',
          pendingRemoveMemberIds: ['removed', 'owner'],
        }),
      }),
    });

    const service = makeService();
    await service.syncScope('accountList', listId);

    expect(mocks.pushEndorsements).toHaveBeenCalledWith([
      { ownerId: 'owner', memberId: 'removed', op: 'remove', sourceId: listId },
      { ownerId: 'owner', memberId: 'keep', op: 'add', sourceId: listId },
    ]);
    const setSent = mocks.outboxUpdateOne.mock.calls.find((c) => c[1]?.$set?.status === 'sent');
    expect(setSent?.[1].$unset).toEqual({ pendingRemoveOwnerId: '', pendingRemoveMemberIds: '' });
  });

  it('pushes an empty add set (no-op) and marks sent when the scope no longer exists', async () => {
    // A pack id that names no row: `null` from the loader means DELETED, which
    // is what makes the service retract rather than skip.
    const service = makeService();
    await service.syncScope('starterPack', 'bfe-no-such-pack');

    expect(mocks.pushEndorsements).toHaveBeenCalledWith([]);
    const setSent = mocks.outboxUpdateOne.mock.calls.find((c) => c[1]?.$set?.status === 'sent');
    expect(setSent).toBeDefined();
  });
});

describe('EndorsementSignalService.syncScopeMembershipChange', () => {
  it('pushes remove edges for pruned members and add edges for the current members', async () => {
    const listId = await seedList('owner', ['keep', 'added']);

    const service = makeService();
    await service.syncScopeMembershipChange(
      'accountList',
      listId,
      'owner',
      ['removed', 'keep', 'owner'],
      ['keep', 'added'],
    );

    const armUpdate = mocks.outboxUpdateOne.mock.calls[0][1];
    expect(armUpdate.$addToSet).toEqual({ pendingRemoveMemberIds: { $each: ['removed'] } });
    expect(mocks.pushEndorsements).toHaveBeenCalledWith([
      { ownerId: 'owner', memberId: 'removed', op: 'remove', sourceId: listId },
      { ownerId: 'owner', memberId: 'keep', op: 'add', sourceId: listId },
      { ownerId: 'owner', memberId: 'added', op: 'add', sourceId: listId },
    ]);
  });

  it('leaves captured removed members pending when the push fails', async () => {
    const packId = await seedPack('owner', ['keep']);
    mocks.pushEndorsements.mockRejectedValue(new Error('oxy down'));
    mocks.outboxFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ attempts: 0 }) }),
    });

    const service = makeService();
    await service.syncScopeMembershipChange('starterPack', 'pack_1', 'owner', ['removed', 'keep'], ['keep']);

    const armUpdate = mocks.outboxUpdateOne.mock.calls[0][1];
    expect(armUpdate.$addToSet).toEqual({ pendingRemoveMemberIds: { $each: ['removed'] } });
    const failUpdate = mocks.outboxUpdateOne.mock.calls.find(
      (c) => c[1]?.$set?.status === 'pending' && typeof c[1]?.$set?.attempts === 'number',
    );
    expect(failUpdate?.[1].$set.error).toBe('oxy down');
    const setSent = mocks.outboxUpdateOne.mock.calls.find((c) => c[1]?.$set?.status === 'sent');
    expect(setSent).toBeUndefined();
  });
});

describe('EndorsementSignalService.syncScopeRemoval', () => {
  it('pushes remove edges for the captured members and clears the outbox row', async () => {
    const service = makeService();
    await service.syncScopeRemoval('accountList', 'list_9', 'owner', ['m1', 'm2', 'owner']);

    expect(mocks.pushEndorsements).toHaveBeenCalledWith([
      { ownerId: 'owner', memberId: 'm1', op: 'remove', sourceId: 'list_9' },
      { ownerId: 'owner', memberId: 'm2', op: 'remove', sourceId: 'list_9' },
    ]);
    expect(mocks.outboxDeleteOne).toHaveBeenCalledWith({ source: 'accountList', sourceId: 'list_9' });
  });

  it('still clears the outbox row even if the remove push fails (best-effort)', async () => {
    mocks.pushEndorsements.mockRejectedValue(new Error('oxy down'));
    const service = makeService();
    await service.syncScopeRemoval('starterPack', 'pack_9', 'owner', ['m1']);
    expect(mocks.outboxDeleteOne).toHaveBeenCalledWith({ source: 'starterPack', sourceId: 'pack_9' });
  });
});

describe('EndorsementSignalService.flushOutbox', () => {
  it('re-syncs each pending row and reports sent/failed counts', async () => {
    const packId = await seedPack('owner', ['m1']);
    mocks.outboxFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([{ source: 'starterPack', sourceId: packId }]),
          }),
        }),
      }),
    });
    // After syncScope, the row is queried for status.
    mocks.outboxFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'sent' }) }),
    });

    const service = makeService();
    const result = await service.flushOutbox();

    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(mocks.pushEndorsements).toHaveBeenCalledTimes(1);
  });
});
