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
import { and, eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  pushEndorsements: vi.fn(),
}));

// The outbox rows are REAL. The stubs that used to sit here let the assertions
// read the `$set` a Mongo static was CALLED with — so they measured what the
// service asked for, and could not see the row's actual state at all: the
// `attempts` increment (now the database's, so two overlapping drains cannot
// compute the same successor), the removal ids UNIONING rather than replacing,
// or `error` surviving a successful send because Mongoose strips an `undefined`
// out of `$set`.

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  accountListMembers,
  accountLists,
  starterPackMembers,
  starterPacks,
} from '../../db/schema/lists';
import { endorsementOutbox } from '../../db/schema/outbox';

/**
 * Scope ids this file uses that name no seeded row — the deletion and
 * missing-scope cases. They still create outbox rows, so cleanup has to know
 * about them.
 */
const EXTRA_SCOPE_IDS = ['bfe-no-such-pack', 'list_9', 'pack_9', 'pack_1'];
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

/** The stored outbox row for a scope, or `undefined`. */
async function outboxRow(source: 'starterPack' | 'accountList', sourceId: string) {
  const [row] = await getDb()
    .select()
    .from(endorsementOutbox)
    .where(and(eq(endorsementOutbox.source, source), eq(endorsementOutbox.sourceId, sourceId)))
    .limit(1);
  return row;
}

const signalsClient = { pushEndorsements: mocks.pushEndorsements, pushInterests: vi.fn() };

function makeService() {
  return new EndorsementSignalService(signalsClient as unknown as never);
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // The outbox is keyed by scope, not by the fixture's own tables, so it needs
  // its own sweep — a leftover `pending` row is picked up by the next file's
  // drain and counted as its work.
  await getDb()
    .delete(endorsementOutbox)
    .where(inArray(endorsementOutbox.sourceId, [...seededListIds, ...seededPackIds, ...EXTRA_SCOPE_IDS]));
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

    // Armed pending first, then marked sent — read off the row, not off the call.
    expect((await outboxRow('starterPack', packId))?.status).toBe('sent');
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

    const service = makeService();
    await service.syncScope('accountList', listId);

    const row = await outboxRow('accountList', listId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.error).toBe('oxy down');
    // The backoff moved the row out of the drain's due window.
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('retries pending remove edges captured from an earlier failed membership change', async () => {
    const listId = await seedList('owner', ['keep']);
    // A real captured removal from an earlier failed change, not a stubbed read.
    await getDb().insert(endorsementOutbox).values({
      source: 'accountList',
      sourceId: listId,
      status: 'pending',
      pendingRemoveOwnerId: 'owner',
      pendingRemoveMemberIds: ['removed', 'owner'],
    });

    const service = makeService();
    await service.syncScope('accountList', listId);

    expect(mocks.pushEndorsements).toHaveBeenCalledWith([
      { ownerId: 'owner', memberId: 'removed', op: 'remove', sourceId: listId },
      { ownerId: 'owner', memberId: 'keep', op: 'add', sourceId: listId },
    ]);
    const row = await outboxRow('accountList', listId);
    expect(row?.status).toBe('sent');
    // The captured removal is CLEARED once it has been pushed — left in place it
    // would be re-retracted on every later sync of the scope.
    expect(row?.pendingRemoveOwnerId).toBeNull();
    expect(row?.pendingRemoveMemberIds).toBeNull();
  });

  it('pushes an empty add set (no-op) and marks sent when the scope no longer exists', async () => {
    // A pack id that names no row: `null` from the loader means DELETED, which
    // is what makes the service retract rather than skip.
    const service = makeService();
    await service.syncScope('starterPack', 'bfe-no-such-pack');

    expect(mocks.pushEndorsements).toHaveBeenCalledWith([]);
    expect((await outboxRow('starterPack', 'bfe-no-such-pack'))?.status).toBe('sent');
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

    expect(mocks.pushEndorsements).toHaveBeenCalledWith([
      { ownerId: 'owner', memberId: 'removed', op: 'remove', sourceId: listId },
      { ownerId: 'owner', memberId: 'keep', op: 'add', sourceId: listId },
      { ownerId: 'owner', memberId: 'added', op: 'add', sourceId: listId },
    ]);
  });

  it('leaves captured removed members pending when the push fails', async () => {
    const packId = await seedPack('owner', ['keep']);
    mocks.pushEndorsements.mockRejectedValue(new Error('oxy down'));

    const service = makeService();
    await service.syncScopeMembershipChange('starterPack', 'pack_1', 'owner', ['removed', 'keep'], ['keep']);

    const row = await outboxRow('starterPack', 'pack_1');
    // The pruned member is RETAINED on the row so the next drain retracts it —
    // nothing can recompute it, the member is already gone from the source.
    expect(row?.pendingRemoveOwnerId).toBe('owner');
    expect(row?.pendingRemoveMemberIds).toEqual(['removed']);
    expect(row?.status).toBe('pending');
    expect(row?.error).toBe('oxy down');
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
    expect(await outboxRow('accountList', 'list_9')).toBeUndefined();
  });

  it('still clears the outbox row even if the remove push fails (best-effort)', async () => {
    mocks.pushEndorsements.mockRejectedValue(new Error('oxy down'));
    const service = makeService();
    await service.syncScopeRemoval('starterPack', 'pack_9', 'owner', ['m1']);
    expect(await outboxRow('starterPack', 'pack_9')).toBeUndefined();
  });
});

describe('EndorsementSignalService.flushOutbox', () => {
  it('re-syncs each pending row and reports sent/failed counts', async () => {
    const packId = await seedPack('owner', ['m1']);
    // A REAL due row, rather than a stubbed page: the drain's own query decides
    // what it picks up, including the `next_attempt_at <= now` gate.
    await getDb().insert(endorsementOutbox).values({
      source: 'starterPack',
      sourceId: packId,
      status: 'pending',
      nextAttemptAt: new Date(Date.now() - 60_000),
    });

    const service = makeService();
    const result = await service.flushOutbox();

    // The drain reads the whole table and vitest runs files in parallel, so this
    // asserts about THIS scope rather than the global tally.
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect((await outboxRow('starterPack', packId))?.status).toBe('sent');
    expect(mocks.pushEndorsements).toHaveBeenCalled();
  });
});
