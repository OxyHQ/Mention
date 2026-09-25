import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError, type Job } from 'bullmq';

const mocks = vi.hoisted(() => ({
  processInboxActivity: vi.fn(),
  deliverActivity: vi.fn(),
  getUserById: vi.fn(),
  findErasedAccountUsernames: vi.fn(),
  processAccountErasure: vi.fn(),
}));

// The erasure ledger is the delivery worker's fallback for a sender Oxy no longer
// resolves (an erased account whose Deletes are still queued).
vi.mock('../../db/accountErasures/accountErasureRepository', () => ({
  findErasedAccountUsernames: mocks.findErasedAccountUsernames,
}));
vi.mock('../../services/accountErasure/AccountErasureService', () => ({
  processAccountErasure: mocks.processAccountErasure,
}));

// `workers.ts` statically imports these singletons. Mock them so the test does
// not pull in the real connector graph or the server entry point.
vi.mock('../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {
    processInboxActivity: mocks.processInboxActivity,
    deliverActivity: mocks.deliverActivity,
  },
}));

vi.mock('../../services/FederationJobScheduler', () => ({
  federationJobScheduler: {},
}));

// `workers.ts` resolves the sender through `getServiceOxyClient()` (the
// service-authed client), not the bare server `oxy` singleton. Mock that helper
// so the delivery worker sees a controllable user lookup without pulling in the
// real server entry point.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById: mocks.getUserById,
  }),
}));

import { processAccountErasureJob, processInboxJob, processDeliveryJob } from '../../queue/workers';

function inboxJob(activity: Record<string, unknown>, verifiedActorUri: string): Job {
  return { data: { activity, verifiedActorUri } } as unknown as Job;
}

function deliveryJob(
  activityJson: Record<string, unknown>,
  targetInbox: string,
  senderOxyUserId: string,
): Job {
  return { data: { activityJson, targetInbox, senderOxyUserId } } as unknown as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.processInboxActivity.mockResolvedValue(undefined);
  mocks.deliverActivity.mockResolvedValue(true);
  mocks.getUserById.mockResolvedValue({ username: 'alice' });
  mocks.findErasedAccountUsernames.mockResolvedValue(new Map());
});

describe('processInboxJob', () => {
  it('delegates to federationService.processInboxActivity with the verified actor', async () => {
    const activity = { id: 'https://remote/activity/1', type: 'Like' };
    await processInboxJob(inboxJob(activity, 'https://remote/users/bob'));

    expect(mocks.processInboxActivity).toHaveBeenCalledWith(activity, 'https://remote/users/bob');
  });

  it('propagates handler errors so BullMQ can retry', async () => {
    mocks.processInboxActivity.mockRejectedValueOnce(new Error('handler boom'));
    await expect(
      processInboxJob(inboxJob({ id: 'x', type: 'Create' }, 'https://remote/users/bob')),
    ).rejects.toThrow('handler boom');
  });
});

describe('processDeliveryJob', () => {
  const activity = { id: 'https://local/activity/1', type: 'Create' };

  it('resolves the sender username and delivers the activity', async () => {
    await processDeliveryJob(deliveryJob(activity, 'https://remote/inbox', 'oxy_alice'));

    expect(mocks.getUserById).toHaveBeenCalledWith('oxy_alice');
    expect(mocks.deliverActivity).toHaveBeenCalledWith(
      activity,
      'https://remote/inbox',
      'oxy_alice',
      'alice',
    );
  });

  it('throws UnrecoverableError (no retry) when the sender is missing', async () => {
    mocks.getUserById.mockResolvedValueOnce(null);

    await expect(
      processDeliveryJob(deliveryJob(activity, 'https://remote/inbox', 'oxy_ghost')),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mocks.deliverActivity).not.toHaveBeenCalled();
  });

  it('throws a retriable (non-unrecoverable) error on a soft delivery failure', async () => {
    mocks.deliverActivity.mockResolvedValue(false);

    const error = await processDeliveryJob(
      deliveryJob(activity, 'https://remote/inbox', 'oxy_alice'),
    ).catch((e: unknown) => e);

    // A soft failure throws a plain Error so BullMQ retries with the tiered
    // backoff — it must NOT be an UnrecoverableError (which would drop the job).
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toMatch(/failed \(will retry\)/);
  });
});

describe('processDeliveryJob for an erased sender', () => {
  const activity = { id: 'https://local/ap/users/gone/posts/1/delete', type: 'Delete' };

  it('signs with the handle the erasure ledger kept when Oxy no longer resolves the sender', async () => {
    mocks.getUserById.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    mocks.findErasedAccountUsernames.mockResolvedValueOnce(new Map([['oxy_gone', 'gone']]));

    await processDeliveryJob(deliveryJob(activity, 'https://remote/inbox', 'oxy_gone'));

    expect(mocks.findErasedAccountUsernames).toHaveBeenCalledWith(['oxy_gone']);
    expect(mocks.deliverActivity).toHaveBeenCalledWith(activity, 'https://remote/inbox', 'oxy_gone', 'gone');
  });

  it('rethrows the Oxy error (retry) for a sender the ledger does not know', async () => {
    mocks.getUserById.mockRejectedValueOnce(new Error('oxy 503'));

    await expect(
      processDeliveryJob(deliveryJob(activity, 'https://remote/inbox', 'oxy_unknown')),
    ).rejects.toThrow('oxy 503');
    expect(mocks.deliverActivity).not.toHaveBeenCalled();
  });

  it('never consults the ledger when Oxy resolves the sender', async () => {
    await processDeliveryJob(deliveryJob(activity, 'https://remote/inbox', 'oxy_alice'));
    expect(mocks.findErasedAccountUsernames).not.toHaveBeenCalled();
  });
});

describe('processAccountErasureJob', () => {
  const job = { data: { eventId: 'evt-1' } } as unknown as Job;

  it('completes quietly when the erasure completes or already had', async () => {
    mocks.processAccountErasure.mockResolvedValueOnce({ outcome: 'completed' });
    await expect(processAccountErasureJob(job)).resolves.toBeUndefined();
    mocks.processAccountErasure.mockResolvedValueOnce({ outcome: 'already-completed' });
    await expect(processAccountErasureJob(job)).resolves.toBeUndefined();
    expect(mocks.processAccountErasure).toHaveBeenCalledWith('evt-1');
  });

  it('throws a retriable error while another task holds the lease', async () => {
    mocks.processAccountErasure.mockResolvedValueOnce({ outcome: 'busy' });
    const error = await processAccountErasureJob(job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it('fails permanently for an event with no ledger row', async () => {
    mocks.processAccountErasure.mockResolvedValueOnce({ outcome: 'unknown-event' });
    await expect(processAccountErasureJob(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
