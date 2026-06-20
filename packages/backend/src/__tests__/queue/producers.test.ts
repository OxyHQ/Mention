import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

const mocks = vi.hoisted(() => ({
  inboxAdd: vi.fn(),
  deliveryAdd: vi.fn(),
  getInboxQueue: vi.fn(),
  getDeliveryQueue: vi.fn(),
}));

vi.mock('../../queue/queues', () => ({
  getInboxQueue: mocks.getInboxQueue,
  getDeliveryQueue: mocks.getDeliveryQueue,
}));

import { enqueueInboxActivity, enqueueDelivery } from '../../queue/producers';
import { DELIVERY_JOB_ATTEMPTS, DELIVERY_BACKOFF_STRATEGY } from '../../queue/constants';

/** Mirror the producer's jobId hash (sha256 hex, first 40 chars). */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 40);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInboxQueue.mockReturnValue({ add: mocks.inboxAdd });
  mocks.getDeliveryQueue.mockReturnValue({ add: mocks.deliveryAdd });
  mocks.inboxAdd.mockResolvedValue(undefined);
  mocks.deliveryAdd.mockResolvedValue(undefined);
});

describe('enqueueInboxActivity', () => {
  it('dedupes inbound activities on a stable jobId derived from the activity id', async () => {
    const activity = { id: 'https://remote/users/bob/statuses/1/activity', type: 'Like' };
    const ok = await enqueueInboxActivity({ activity, verifiedActorUri: 'https://remote/users/bob' });

    expect(ok).toBe(true);
    expect(mocks.inboxAdd).toHaveBeenCalledWith(
      'inbox',
      { activity, verifiedActorUri: 'https://remote/users/bob' },
      { jobId: `inbox:${shortHash(activity.id)}` },
    );
  });

  it('produces the SAME jobId for a redelivered identical activity (idempotent enqueue)', async () => {
    const activity = { id: 'https://remote/users/bob/statuses/1/activity', type: 'Like' };
    await enqueueInboxActivity({ activity, verifiedActorUri: 'https://remote/users/bob' });
    await enqueueInboxActivity({ activity, verifiedActorUri: 'https://remote/users/bob' });

    const firstJobId = mocks.inboxAdd.mock.calls[0][2].jobId;
    const secondJobId = mocks.inboxAdd.mock.calls[1][2].jobId;
    expect(firstJobId).toBe(secondJobId);
  });

  it('falls back (returns false) when the activity has no stable id to dedupe on', async () => {
    const ok = await enqueueInboxActivity({
      activity: { type: 'Like' },
      verifiedActorUri: 'https://remote/users/bob',
    });

    expect(ok).toBe(false);
    expect(mocks.inboxAdd).not.toHaveBeenCalled();
  });

  it('returns false when no queue is available (caller processes inline)', async () => {
    mocks.getInboxQueue.mockReturnValue(null);
    const ok = await enqueueInboxActivity({
      activity: { id: 'https://remote/a/1', type: 'Like' },
      verifiedActorUri: 'https://remote/users/bob',
    });

    expect(ok).toBe(false);
  });
});

describe('enqueueDelivery', () => {
  it('dedupes deliveries on (targetInbox + activity id) with retry options', async () => {
    const activityJson = { id: 'https://local/a/1', type: 'Create' };
    const ok = await enqueueDelivery({
      activityJson,
      targetInbox: 'https://remote/inbox',
      senderOxyUserId: 'oxy_alice',
    });

    expect(ok).toBe(true);
    expect(mocks.deliveryAdd).toHaveBeenCalledWith(
      'delivery',
      { activityJson, targetInbox: 'https://remote/inbox', senderOxyUserId: 'oxy_alice' },
      {
        jobId: `delivery:${shortHash('https://remote/inbox|https://local/a/1')}`,
        attempts: DELIVERY_JOB_ATTEMPTS,
        backoff: { type: DELIVERY_BACKOFF_STRATEGY },
      },
    );
  });

  it('omits the jobId (every enqueue is distinct) when the activity has no id', async () => {
    const ok = await enqueueDelivery({
      activityJson: { type: 'Create' },
      targetInbox: 'https://remote/inbox',
      senderOxyUserId: 'oxy_alice',
    });

    expect(ok).toBe(true);
    const options = mocks.deliveryAdd.mock.calls[0][2];
    expect(options.jobId).toBeUndefined();
    expect(options.attempts).toBe(DELIVERY_JOB_ATTEMPTS);
  });
});
