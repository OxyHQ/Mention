/**
 * `POST /posts` must not wait on notifications addressed to other people.
 *
 * The author's response is built from the post and from federation; every
 * notification the create path writes is for somebody else. Waiting on them
 * charged the author a fan-out that scales with their own popularity — the
 * `post_subscriptions` select has no LIMIT, and each recipient costs an INSERT,
 * a conditional UPDATE and a push-token SELECT, plus an FCM multicast for anyone
 * holding a device.
 *
 * Measured against a seeded database with Oxy and push stubbed, `create` on a
 * public post with 200 subscribers took ~112 ms of request time with a
 * zero-latency Oxy and ~1618 ms with a 60 ms one; detached it is ~51 ms and
 * ~19 ms. The work is not cheaper — it is off the request.
 *
 * ## Why this test is shaped as a race
 *
 * "Detached" is a claim about ORDER, not about output: the same rows are written
 * either way. So the only thing that can distinguish the two is whether `create`
 * resolves while the fan-out is still pending, which is what the deferred
 * `createBatchNotifications` below makes observable. Restoring the `await`
 * leaves `create` blocked on a promise this test has not released yet, and the
 * first assertion fails.
 *
 * The second assertion is the negative control, and it is the reason the first
 * one is not enough on its own: deleting the fan-out entirely would also make
 * `create` resolve immediately — the right number for the worst reason. So the
 * work must also be REGISTERED with the shutdown drain, and must actually run
 * once released.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The gate the fan-out blocks on. Created EAGERLY rather than inside the mock,
 * because the detached fan-out has not necessarily reached its first `await`
 * when `create` resolves — which is the behaviour under test, so the test cannot
 * depend on it having got that far.
 */
let releaseFanOut!: () => void;
let fanOutGate: Promise<void>;
function armFanOutGate(): void {
  fanOutGate = new Promise<void>((resolve) => {
    releaseFanOut = resolve;
  });
}
armFanOutGate();

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn(() => fanOutGate),
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost: vi.fn().mockResolvedValue(undefined) }),
  registerPostCreator: vi.fn(),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: vi.fn().mockResolvedValue([]),
    getUserById: vi.fn().mockResolvedValue(null),
  }),
}));

import { eq } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postSubscriptions } from '../../db/schema/engagement';
import { postCreationService } from '../../services/PostCreationService';
import { createBatchNotifications } from '../../utils/notificationUtils';
import {
  drainBackgroundWork,
  resetBackgroundWorkForTests,
  trackedBackgroundWorkCount,
} from '../../runtime/backgroundWork';
import { clearServiceScope, serviceScope, trackPost } from '../helpers/serviceFixtures';

const scope = serviceScope('post-create-fanout-detached');
const AUTHOR = scope.user('author');

describe('POST /posts does not await the notification fan-out', () => {
  beforeAll(async () => {
    await connectPostgres();
    await getDb()
      .insert(postSubscriptions)
      .values({ subscriberId: scope.user('subscriber'), authorId: AUTHOR });
  });

  afterEach(() => {
    armFanOutGate();
    resetBackgroundWorkForTests();
    vi.mocked(createBatchNotifications).mockClear();
  });

  afterAll(async () => {
    await getDb().delete(postSubscriptions).where(eq(postSubscriptions.authorId, AUTHOR));
    await clearServiceScope(scope);
    await closePostgres();
  });

  it('returns to the author while the fan-out is still in flight, and still drains it', async () => {
    // The fan-out is blocked on a gate this test has not released. An awaited
    // version cannot resolve at all until it is, so the race is the assertion:
    // restoring the `await` makes `create` lose to the timer.
    const settled = await Promise.race([
      postCreationService
        .create({
          oxyUserId: AUTHOR,
          content: { text: 'detached fan-out', media: [] },
          visibility: PostVisibility.PUBLIC,
          skipSocketEmit: true,
          skipFederationDelivery: true,
        } as never)
        .then((post) => ({ returned: true, post })),
      new Promise<{ returned: false; post: undefined }>((resolve) =>
        setTimeout(() => resolve({ returned: false, post: undefined }), 5_000),
      ),
    ]);

    expect(settled.returned).toBe(true);
    if (settled.post) trackPost(scope, settled.post.id);

    // Negative control: detaching must not mean dropping. The work is registered
    // with the drain, so `gracefulShutdown` still waits for it in the phase where
    // Postgres and Redis are still open — and it must actually run once released.
    // Without this, deleting the fan-out outright would pass the assertion above.
    expect(trackedBackgroundWorkCount()).toBeGreaterThan(0);

    releaseFanOut();
    const drained = await drainBackgroundWork(10_000);

    expect(drained).toBe(true);
    expect(vi.mocked(createBatchNotifications)).toHaveBeenCalledTimes(1);
  }, 30_000);
});
