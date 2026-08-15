import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mention notification fan-out cap.
 *
 * A post that names more than `MAX_MENTION_NOTIFICATIONS_PER_POST` distinct users
 * is a broadcast, not a conversation, and notifies NOBODY. Measured motivation: the
 * reply-all pile-up thread at `annihilation.social` (1,870 posts) averaged 28.9
 * mentions per post, max 34 — every post there addressed the whole participant
 * list, so a local user pulled into it would have been rung once per post.
 *
 * These pin the DECISION (nobody, not the first N), the exact boundary (at the cap
 * everyone is notified; one over, no one is), and the observability that makes the
 * suppression visible instead of a silent drop.
 */

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  formatPushForNotification: vi.fn(),
  sendPushToUser: vi.fn(),
}));

/**
 * `notifications` is REAL. The cap's whole subject is WHO ends up with a row, so
 * the observable has to be the rows: a `save` spy could only ever report how many
 * documents the writer built, and `createNotification` dedupes on a unique index
 * that a double does not have.
 */
vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn() }));
// No socket server → the real-time emit branch is skipped entirely.
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../utils/push', () => ({
  formatPushForNotification: mocks.formatPushForNotification,
  sendPushToUser: mocks.sendPushToUser,
}));

import { eq } from 'drizzle-orm';
import {
  MAX_MENTION_NOTIFICATIONS_PER_POST as CAP,
  isMentionBroadcast,
} from '@mention/shared-types/mentions';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { notifications } from '../../db/schema/discovery';
import { createMentionNotifications } from '../../utils/notificationUtils';

/**
 * Namespaced: vitest runs files in parallel against one database, and the rows
 * are found by `entity_id`, so a bare `post_1` would be a claim about every
 * other file in the run.
 */
const RUN = 'mention-cap';
const AUTHOR = `${RUN}_author`;
const POST_ID = `${RUN}_post`;

/** `count` distinct mentioned user ids, none of them the author. */
const mentionIds = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${RUN}_mentioned_${i}`);

/**
 * The recipient ids that actually have a row, SORTED — the set, not a sequence.
 *
 * This used to order by `id` and call the result insertion order, on the grounds
 * that uuid v7 is monotonic. It is NOT: `uuidv7()` (`@oxyhq/db`) is 48
 * bits of `Date.now()` followed by `randomFillSync`, with none of RFC 9562's
 * optional monotonic counter, so two rows sharing a millisecond order on their
 * random tail — measured at a ~50/50 split, the same coin flip
 * `services/profileLinkMentionWrites.test.ts` records having hit for real.
 * `db/posts/postRepository.ts` states the rule.
 *
 * `createMentionNotifications` fans out in a sequential loop of separate round
 * trips, so the rows usually — never reliably — land in distinct milliseconds.
 * Every collision was a 50% chance of transposing two names inside an ordered
 * `toEqual`, which is a red failure arriving at random, with no code change, and
 * reading as a cap regression.
 *
 * Sorting is the right answer here rather than pinning the ids, because ORDER
 * CARRIES NO MEANING: every case below asks who was notified and how many — the
 * cap's decision — and nothing reads notifications in id sequence. The
 * assertions keep their full force; a truncated prefix, a missing recipient, an
 * extra one or a wrongly suppressed fan-out all still fail.
 */
const notifiedRecipients = async (): Promise<string[]> => {
  const rows = await getDb()
    .select({ recipientId: notifications.recipientId })
    .from(notifications)
    .where(eq(notifications.entityId, POST_ID));
  return rows.map((row) => row.recipientId).sort();
};

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await getDb().delete(notifications).where(eq(notifications.entityId, POST_ID));
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await getDb().delete(notifications).where(eq(notifications.entityId, POST_ID));
  mocks.formatPushForNotification.mockResolvedValue({ title: 't', body: 'b' });
  mocks.sendPushToUser.mockResolvedValue(undefined);
});

describe('isMentionBroadcast — the shared predicate', () => {
  it('holds the measured value — moving it must be a deliberate act', () => {
    // The boundary cases below are parameterised on the constant, so they follow it
    // wherever it goes. This one does not: it is what fails if the cap is quietly
    // widened, and it is the reason the number has to be re-justified against the
    // measured distribution rather than nudged.
    expect(CAP).toBe(8);
  });

  it('is false AT the cap and true one over it', () => {
    expect(isMentionBroadcast(CAP)).toBe(false);
    expect(isMentionBroadcast(CAP + 1)).toBe(true);
  });

  it('never treats an ordinary conversation as a broadcast', () => {
    for (let n = 0; n <= CAP; n++) expect(isMentionBroadcast(n)).toBe(false);
  });
});

describe('createMentionNotifications — fan-out cap boundary', () => {
  it(`notifies every mentioned user AT the cap (${CAP})`, async () => {
    await createMentionNotifications(mentionIds(CAP), POST_ID, AUTHOR, 'post');

    expect(await notifiedRecipients()).toEqual([...mentionIds(CAP)].sort());
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it(`notifies NOBODY one over the cap (${CAP + 1}) — not the first ${CAP}`, async () => {
    await createMentionNotifications(mentionIds(CAP + 1), POST_ID, AUTHOR, 'post');

    // The decision under test: nobody, rather than a truncated prefix. A prefix
    // would be attacker-orderable, and in a reply-all pile-up the early names are
    // inherited by every reply — so "first N" would deliver the whole flood to
    // exactly the people the cap exists to protect.
    expect(await notifiedRecipients()).toEqual([]);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it('notifies nobody for the measured pile-up shape (29 mentions)', async () => {
    // The observed mean of the thread that motivated the cap.
    await createMentionNotifications(mentionIds(29), POST_ID, AUTHOR, 'post');

    expect(await notifiedRecipients()).toEqual([]);
  });

  it('counts DISTINCT users, so duplicates cannot push an honest post over', async () => {
    const duplicated = [...mentionIds(CAP), ...mentionIds(CAP)];

    await createMentionNotifications(duplicated, POST_ID, AUTHOR, 'post');

    expect(await notifiedRecipients()).toEqual([...mentionIds(CAP)].sort());
  });
});

describe('createMentionNotifications — suppression is observable', () => {
  it('logs the suppression with both the mentioned count and the cap', async () => {
    await createMentionNotifications(mentionIds(CAP + 1), POST_ID, AUTHOR, 'post');

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '[Notifications] suppressed mention fan-out for a broadcast post',
      { mentioned: CAP + 1, cap: CAP },
    );
  });

  it('reports the DISTINCT count it actually judged, not the raw list length', async () => {
    // 2 distinct users repeated to a raw length well over the cap: the post is not
    // a broadcast, so nothing is suppressed and nothing is logged.
    await createMentionNotifications(
      Array.from({ length: 40 }, (_, i) => `${RUN}_mentioned_${i % 2}`),
      POST_ID,
      AUTHOR,
      'post',
    );

    expect(mocks.loggerWarn).not.toHaveBeenCalled();
    expect(await notifiedRecipients()).toEqual([`${RUN}_mentioned_0`, `${RUN}_mentioned_1`].sort());
  });
});
