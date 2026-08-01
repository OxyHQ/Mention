/**
 * Push delivery against real `push_tokens` rows.
 *
 * Two ported queries live here and neither announces a mistake: the fan-out
 * SELECT (this user, enabled, `fcm`) and the invalidation UPDATE that disables
 * the tokens FCM rejected. The second is the `inArray` case the migration
 * contract calls out — a hand-built `= any(${array})` binds a ROW constructor
 * and Postgres refuses it at runtime only, so it has to be exercised against a
 * real server rather than a mock.
 *
 * Firebase itself is stubbed: what is under test is which rows are read, which
 * tokens are sent to, and which rows come back disabled.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  sendEachForMulticast: vi.fn(),
  initializeApp: vi.fn(),
  getUserById: vi.fn(),
  postFindById: vi.fn(),
}));

vi.mock('firebase-admin', () => ({
  default: {
    initializeApp: mocks.initializeApp,
    credential: { cert: vi.fn() },
    messaging: () => ({ sendEachForMulticast: mocks.sendEachForMulticast }),
  },
}));

vi.mock('../../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config')>()),
  getFirebaseConfig: () => ({
    serviceAccountBase64: Buffer.from('{"project_id":"test"}').toString('base64'),
    projectId: 'test',
  }),
}));

vi.mock('../../models/Post', () => ({ default: { findById: mocks.postFindById } }));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUserById: mocks.getUserById }),
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { pushTokens } from '../../db/schema/discovery';
import { formatPushForNotification, sendPushToUser } from '../../utils/push';

let db: Database;
const createdUserIds: string[] = [];

function userId(): string {
  const id = `oxy-push-${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

function tokenValue(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** The tokens the multicast was actually asked to deliver to, flattened. */
function sentTokens(): string[] {
  return mocks.sendEachForMulticast.mock.calls.flatMap(
    ([message]: [{ tokens: string[] }]) => message.tokens,
  );
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendEachForMulticast.mockResolvedValue({ responses: [] });
  mocks.getUserById.mockResolvedValue({ id: 'actor-1', name: { displayName: 'Ada' } });
  mocks.postFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
});

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(pushTokens).where(inArray(pushTokens.userId, createdUserIds));
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('sendPushToUser', () => {
  it('sends only to this user’s ENABLED fcm tokens', async () => {
    const target = userId();
    const other = userId();
    const wanted = tokenValue('fcm-wanted');

    await db.insert(pushTokens).values([
      { userId: target, token: wanted, type: 'fcm', enabled: true },
      { userId: target, token: tokenValue('fcm-disabled'), type: 'fcm', enabled: false },
      { userId: target, token: tokenValue('apns'), type: 'apns', enabled: true },
      { userId: other, token: tokenValue('fcm-other'), type: 'fcm', enabled: true },
    ]);

    await sendPushToUser(target, { title: 't', body: 'b' });

    // Exactly one token, and it is a NON-EMPTY set — a fan-out that silently
    // matched nothing would satisfy "did not send to the wrong user" too.
    expect(sentTokens()).toEqual([wanted]);
  });

  it('does not call FCM at all when the user has no deliverable token', async () => {
    const target = userId();
    await db.insert(pushTokens).values({
      userId: target,
      token: tokenValue('apns'),
      type: 'apns',
      enabled: true,
    });

    await sendPushToUser(target, { title: 't', body: 'b' });
    expect(mocks.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('disables exactly the tokens FCM reported as unregistered', async () => {
    const target = userId();
    const dead = tokenValue('fcm-dead');
    const alive = tokenValue('fcm-alive');
    await db.insert(pushTokens).values([
      { userId: target, token: dead, type: 'fcm', enabled: true },
      { userId: target, token: alive, type: 'fcm', enabled: true },
    ]);

    mocks.sendEachForMulticast.mockImplementation(async (message: { tokens: string[] }) => ({
      responses: message.tokens.map((token) => ({
        success: token !== dead,
        error: token === dead
          ? { errorInfo: { code: 'messaging/registration-token-not-registered' } }
          : undefined,
      })),
    }));

    await sendPushToUser(target, { title: 't', body: 'b' });

    const rows = await db.select().from(pushTokens).where(eq(pushTokens.userId, target));
    const enabledByToken = new Map(rows.map((row) => [row.token, row.enabled]));
    expect(enabledByToken.get(dead)).toBe(false);
    expect(enabledByToken.get(alive)).toBe(true);
  });

  it('leaves every token enabled when the whole multicast succeeded', async () => {
    // The vacuity floor for the case above: a disable-everything bug would pass
    // it, since the assertion there only names one token.
    const target = userId();
    const token = tokenValue('fcm');
    await db.insert(pushTokens).values({ userId: target, token, type: 'fcm', enabled: true });
    mocks.sendEachForMulticast.mockResolvedValue({ responses: [{ success: true }] });

    await sendPushToUser(target, { title: 't', body: 'b' });

    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(row.enabled).toBe(true);
  });
});

describe('formatPushForNotification', () => {
  it('carries the row id as notificationId — the field that used to read _id', async () => {
    const push = await formatPushForNotification({
      id: 'notification-1',
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
      actorId: 'actor-1',
    });

    expect(push.data).toMatchObject({
      notificationId: 'notification-1',
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
      actorId: 'actor-1',
    });
    expect(push.body).toBe('Ada liked your post');
  });

  it('falls back to a neutral actor name when Oxy cannot resolve one', async () => {
    mocks.getUserById.mockRejectedValue(new Error('oxy unavailable'));
    const push = await formatPushForNotification({
      id: 'notification-1',
      type: 'follow',
      entityId: 'oxy-actor-1',
      entityType: 'profile',
      actorId: 'actor-1',
    });
    expect(push.body).toBe('Someone followed you');
  });

  it('names the system actor for a welcome notification', async () => {
    const push = await formatPushForNotification({
      id: 'notification-1',
      type: 'welcome',
      entityId: 'oxy-user-1',
      entityType: 'profile',
      actorId: 'system',
    });
    expect(push).toMatchObject({ title: 'Welcome to Mention' });
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });
});
