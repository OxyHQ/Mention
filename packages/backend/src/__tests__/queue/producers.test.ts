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
import {
  DELIVERY_JOB_ATTEMPTS,
  DELIVERY_BACKOFF_STRATEGY,
  INBOX_JOB_ATTEMPTS,
  INBOX_BACKOFF_BASE_MS,
} from '../../queue/constants';

/** Mirror the producer's jobId hash (sha256 hex, first 40 chars). */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 40);
}

/**
 * BullMQ rejects a custom jobId that contains a `:` unless it splits into
 * exactly 3 parts (a deprecated compat path). Producer jobIds must therefore
 * carry NO colon at all — a `<prefix>:<hash>` (2-part) id threw at enqueue time
 * and every job silently fell back to the Mongo queue. This asserts the real
 * invariant the mocked `add` cannot enforce for us.
 */
function expectValidBullmqJobId(jobId: unknown): void {
  expect(typeof jobId).toBe('string');
  expect(jobId as string).not.toContain(':');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInboxQueue.mockReturnValue({ add: mocks.inboxAdd });
  mocks.getDeliveryQueue.mockReturnValue({ add: mocks.deliveryAdd });
  mocks.inboxAdd.mockResolvedValue(undefined);
  mocks.deliveryAdd.mockResolvedValue(undefined);
});

describe('enqueueInboxActivity', () => {
  it('dedupes inbound activities on a stable jobId derived from the verified actor and activity id', async () => {
    const activity = { id: 'https://remote/users/bob/statuses/1/activity', type: 'Like' };
    const ok = await enqueueInboxActivity({ activity, verifiedActorUri: 'https://remote/users/bob' });

    expect(ok).toBe(true);
    const expectedJobId = `inbox-${shortHash(`https://remote/users/bob|${activity.id}`)}`;

    expect(mocks.inboxAdd).toHaveBeenCalledWith(
      'inbox',
      { activity, verifiedActorUri: 'https://remote/users/bob' },
      {
        jobId: expectedJobId,
        attempts: INBOX_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: INBOX_BACKOFF_BASE_MS },
      },
    );
    // The generated id must be a legal BullMQ custom id (no colon).
    expectValidBullmqJobId(expectedJobId);
    expectValidBullmqJobId(mocks.inboxAdd.mock.calls[0][2].jobId);
  });

  it('produces the SAME jobId for a redelivered identical activity (idempotent enqueue)', async () => {
    const activity = { id: 'https://remote/users/bob/statuses/1/activity', type: 'Like' };
    await enqueueInboxActivity({ activity, verifiedActorUri: 'https://remote/users/bob' });
    await enqueueInboxActivity({ activity, verifiedActorUri: 'https://remote/users/bob' });

    const firstJobId = mocks.inboxAdd.mock.calls[0][2].jobId;
    const secondJobId = mocks.inboxAdd.mock.calls[1][2].jobId;
    expect(firstJobId).toBe(secondJobId);
  });

  it('does not collide when different verified actors reuse the same activity id', async () => {
    const activity = { id: 'https://remote/shared/activity', type: 'Like' };

    await enqueueInboxActivity({ activity, verifiedActorUri: 'https://remote/users/bob' });
    await enqueueInboxActivity({ activity, verifiedActorUri: 'https://evil.example/users/mallory' });

    const firstJobId = mocks.inboxAdd.mock.calls[0][2].jobId;
    const secondJobId = mocks.inboxAdd.mock.calls[1][2].jobId;
    const bobJobId = `inbox-${shortHash(`https://remote/users/bob|${activity.id}`)}`;
    const malloryJobId = `inbox-${shortHash(`https://evil.example/users/mallory|${activity.id}`)}`;

    expect(firstJobId).toBe(bobJobId);
    expect(secondJobId).toBe(malloryJobId);
    expect(firstJobId).not.toBe(secondJobId);
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
        jobId: `delivery-${shortHash('https://remote/inbox|https://local/a/1')}`,
        attempts: DELIVERY_JOB_ATTEMPTS,
        backoff: { type: DELIVERY_BACKOFF_STRATEGY },
      },
    );
  });

  it('builds a colon-free jobId even though the inbox URL and activity id contain colons', async () => {
    // Regression: the raw inputs are full URLs (`https://…`), so a naive jobId
    // carried colons and BullMQ rejected it — every delivery fell back to Mongo.
    const ok = await enqueueDelivery({
      activityJson: { id: 'https://local.example/users/alice/statuses/1', type: 'Create' },
      targetInbox: 'https://remote.example:8443/users/bob/inbox',
      senderOxyUserId: 'oxy_alice',
    });

    expect(ok).toBe(true);
    expectValidBullmqJobId(mocks.deliveryAdd.mock.calls[0][2].jobId);
  });

  it('produces the SAME colon-free jobId for an identical redelivery (stable dedupe)', async () => {
    const data = {
      activityJson: { id: 'https://local/a/1', type: 'Create' },
      targetInbox: 'https://remote/inbox',
      senderOxyUserId: 'oxy_alice',
    };
    await enqueueDelivery(data);
    await enqueueDelivery(data);

    const firstJobId = mocks.deliveryAdd.mock.calls[0][2].jobId;
    const secondJobId = mocks.deliveryAdd.mock.calls[1][2].jobId;
    expect(firstJobId).toBe(secondJobId);
    expectValidBullmqJobId(firstJobId);
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
