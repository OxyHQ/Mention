import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  packFindById: vi.fn(),
  listFindById: vi.fn(),
  outboxUpdateOne: vi.fn(),
  outboxFindOne: vi.fn(),
  outboxFind: vi.fn(),
  outboxDeleteOne: vi.fn(),
  pushEndorsements: vi.fn(),
}));

vi.mock('../../models/StarterPack', () => ({ default: { findById: mocks.packFindById } }));
vi.mock('../../models/AccountList', () => ({ default: { findById: mocks.listFindById } }));

vi.mock('../../models/EndorsementOutbox', () => ({
  default: {
    updateOne: mocks.outboxUpdateOne,
    findOne: mocks.outboxFindOne,
    find: mocks.outboxFind,
    deleteOne: mocks.outboxDeleteOne,
  },
  getEndorsementNextAttempt: (attempts: number) => new Date(1000 + attempts),
}));

import { EndorsementSignalService } from '../../services/EndorsementSignalService';

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
    mocks.packFindById.mockImplementation(
      findByIdLean({ ownerOxyUserId: 'owner', memberOxyUserIds: ['m1', 'm2', 'owner', 'm1'] }),
    );

    const service = makeService();
    await service.syncScope('starterPack', 'pack_1');

    expect(mocks.pushEndorsements).toHaveBeenCalledTimes(1);
    const edges = mocks.pushEndorsements.mock.calls[0][0];
    expect(edges).toEqual([
      { ownerId: 'owner', memberId: 'm1', op: 'add', sourceId: 'pack_1' },
      { ownerId: 'owner', memberId: 'm2', op: 'add', sourceId: 'pack_1' },
    ]);

    // Armed pending first, then marked sent.
    const setSent = mocks.outboxUpdateOne.mock.calls.find(
      (c) => c[1]?.$set?.status === 'sent',
    );
    expect(setSent).toBeDefined();
  });

  it('is idempotent — re-running pushes the same edges again', async () => {
    mocks.packFindById.mockImplementation(
      findByIdLean({ ownerOxyUserId: 'owner', memberOxyUserIds: ['m1'] }),
    );

    const service = makeService();
    await service.syncScope('starterPack', 'pack_1');
    await service.syncScope('starterPack', 'pack_1');

    expect(mocks.pushEndorsements).toHaveBeenCalledTimes(2);
    expect(mocks.pushEndorsements.mock.calls[0][0]).toEqual(mocks.pushEndorsements.mock.calls[1][0]);
  });

  it('leaves the outbox row PENDING with backoff when Oxy is down', async () => {
    mocks.listFindById.mockImplementation(
      findByIdLean({ ownerOxyUserId: 'owner', memberOxyUserIds: ['m1'] }),
    );
    mocks.pushEndorsements.mockRejectedValue(new Error('oxy down'));
    mocks.outboxFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ attempts: 0 }) }),
    });

    const service = makeService();
    await service.syncScope('accountList', 'list_1');

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
    mocks.listFindById.mockImplementation(
      findByIdLean({ ownerOxyUserId: 'owner', memberOxyUserIds: ['keep'] }),
    );
    mocks.outboxFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          pendingRemoveOwnerId: 'owner',
          pendingRemoveMemberIds: ['removed', 'owner'],
        }),
      }),
    });

    const service = makeService();
    await service.syncScope('accountList', 'list_1');

    expect(mocks.pushEndorsements).toHaveBeenCalledWith([
      { ownerId: 'owner', memberId: 'removed', op: 'remove', sourceId: 'list_1' },
      { ownerId: 'owner', memberId: 'keep', op: 'add', sourceId: 'list_1' },
    ]);
    const setSent = mocks.outboxUpdateOne.mock.calls.find((c) => c[1]?.$set?.status === 'sent');
    expect(setSent?.[1].$unset).toEqual({ pendingRemoveOwnerId: '', pendingRemoveMemberIds: '' });
  });

  it('pushes an empty add set (no-op) and marks sent when the scope no longer exists', async () => {
    mocks.packFindById.mockImplementation(findByIdLean(null));

    const service = makeService();
    await service.syncScope('starterPack', 'gone');

    expect(mocks.pushEndorsements).toHaveBeenCalledWith([]);
    const setSent = mocks.outboxUpdateOne.mock.calls.find((c) => c[1]?.$set?.status === 'sent');
    expect(setSent).toBeDefined();
  });
});

describe('EndorsementSignalService.syncScopeMembershipChange', () => {
  it('pushes remove edges for pruned members and add edges for the current members', async () => {
    mocks.listFindById.mockImplementation(
      findByIdLean({ ownerOxyUserId: 'owner', memberOxyUserIds: ['keep', 'added'] }),
    );

    const service = makeService();
    await service.syncScopeMembershipChange(
      'accountList',
      'list_1',
      'owner',
      ['removed', 'keep', 'owner'],
      ['keep', 'added'],
    );

    const armUpdate = mocks.outboxUpdateOne.mock.calls[0][1];
    expect(armUpdate.$addToSet).toEqual({ pendingRemoveMemberIds: { $each: ['removed'] } });
    expect(mocks.pushEndorsements).toHaveBeenCalledWith([
      { ownerId: 'owner', memberId: 'removed', op: 'remove', sourceId: 'list_1' },
      { ownerId: 'owner', memberId: 'keep', op: 'add', sourceId: 'list_1' },
      { ownerId: 'owner', memberId: 'added', op: 'add', sourceId: 'list_1' },
    ]);
  });

  it('leaves captured removed members pending when the push fails', async () => {
    mocks.packFindById.mockImplementation(
      findByIdLean({ ownerOxyUserId: 'owner', memberOxyUserIds: ['keep'] }),
    );
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
    mocks.outboxFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([{ source: 'starterPack', sourceId: 'pack_1' }]),
          }),
        }),
      }),
    });
    mocks.packFindById.mockImplementation(
      findByIdLean({ ownerOxyUserId: 'owner', memberOxyUserIds: ['m1'] }),
    );
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
