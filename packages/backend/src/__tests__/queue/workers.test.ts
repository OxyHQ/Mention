import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError, type Job } from 'bullmq';

const mocks = vi.hoisted(() => ({
  processInboxActivity: vi.fn(),
  deliverActivity: vi.fn(),
  getUserById: vi.fn(),
}));

// `workers.ts` statically imports these singletons. Mock them so the test does
// not pull in the real FederationService graph or the server entry point.
vi.mock('../../services/FederationService', () => ({
  federationService: {
    processInboxActivity: mocks.processInboxActivity,
    deliverActivity: mocks.deliverActivity,
  },
}));

vi.mock('../../services/FederationJobScheduler', () => ({
  federationJobScheduler: {},
}));

vi.mock('../../../server', () => ({
  oxy: {
    getUserById: mocks.getUserById,
  },
}));

import { processInboxJob, processDeliveryJob } from '../../queue/workers';

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
