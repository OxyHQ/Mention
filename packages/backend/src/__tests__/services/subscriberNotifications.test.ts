/**
 * The subscriber fan-out against real `post_subscriptions` rows: it reads the
 * audience a page at a time, hands off to the queue when there is one, and a
 * queued job re-reads the post before announcing it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  batch: vi.fn(async (_items: { recipientId: string }[]) => {}),
  strictBatch: vi.fn(async (_items: { recipientId: string }[]) => {}),
  enqueue: vi.fn(async () => false),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createBatchNotifications: mocks.batch,
  createBatchNotificationsStrict: mocks.strictBatch,
}));
vi.mock('../../queue/producers', () => ({ enqueueSubscriberNotifications: mocks.enqueue }));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postSubscriptions } from '../../db/schema/engagement';
import {
  SUBSCRIBER_ENQUEUE_TIMEOUT_MS,
  SUBSCRIBER_NOTIFICATION_BATCH,
  announcePostToSubscribers,
  deliverSubscriberNotifications,
  runSubscriberNotificationJob,
} from '../../services/notifications/subscriberNotifications';
import { serviceScope } from '../helpers/serviceFixtures';

const scope = serviceScope('subscriber-notifications');
const AUTHOR = scope.user('author');
const AUDIENCE = SUBSCRIBER_NOTIFICATION_BATCH + 3;
const JOB = { postId: scope.user('post'), authorId: AUTHOR };

const recipients = (mock: typeof mocks.batch) =>
  mock.mock.calls.flatMap(([items]) => items.map((item) => item.recipientId));

describe('subscriber notifications', () => {
  beforeAll(async () => {
    await connectPostgres();
    await getDb()
      .insert(postSubscriptions)
      .values([
        ...Array.from({ length: AUDIENCE }, (_, index) => ({
          subscriberId: scope.user(`reader-${String(index).padStart(4, '0')}`),
          authorId: AUTHOR,
        })),
        { subscriberId: AUTHOR, authorId: AUTHOR },
      ]);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueue.mockResolvedValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await getDb().delete(postSubscriptions).where(eq(postSubscriptions.authorId, AUTHOR));
    await closePostgres();
  });

  it('notifies every subscriber once, in pages, and never the author', async () => {
    await deliverSubscriberNotifications(JOB);
    expect(mocks.batch).toHaveBeenCalledTimes(2);
    const notified = recipients(mocks.batch);
    expect(new Set(notified).size).toBe(AUDIENCE);
    expect(notified).toHaveLength(AUDIENCE);
    expect(notified).not.toContain(AUTHOR);
    expect(mocks.strictBatch).not.toHaveBeenCalled();
  });

  it('lets a failed write reject in strict mode, so the job retries', async () => {
    mocks.strictBatch.mockRejectedValueOnce(new Error('database away'));
    await expect(deliverSubscriberNotifications(JOB, { strict: true })).rejects.toThrow(
      'database away',
    );
  });

  it('leaves the fan-out to the queue when the job is accepted', async () => {
    mocks.enqueue.mockResolvedValue(true);
    await announcePostToSubscribers(JOB);
    expect(mocks.enqueue).toHaveBeenCalledWith(JOB);
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it.each([
    ['there is no queue', () => mocks.enqueue.mockResolvedValue(false)],
    ['the enqueue fails', () => mocks.enqueue.mockRejectedValue(new Error('no redis'))],
  ])('runs in process when %s', async (_label, arrange) => {
    arrange();
    await announcePostToSubscribers(JOB);
    expect(recipients(mocks.batch)).toHaveLength(AUDIENCE);
  });

  it('runs in process when the queue does not answer', async () => {
    mocks.enqueue.mockReturnValue(new Promise<boolean>(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const announced = announcePostToSubscribers(JOB);
    await vi.advanceTimersByTimeAsync(SUBSCRIBER_ENQUEUE_TIMEOUT_MS);
    vi.useRealTimers();
    await announced;
    expect(recipients(mocks.batch)).toHaveLength(AUDIENCE);
  });

  it('announces nothing for a post that is gone by the time the job runs', async () => {
    await runSubscriberNotificationJob(JOB);
    expect(mocks.strictBatch).not.toHaveBeenCalled();
  });
});
