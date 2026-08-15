/**
 * A channel's notifications, at the surface an operator actually reads.
 *
 * `notificationInboxScope.test.ts` pins WHO the recipients are; this suite pins
 * what that means for `GET /notifications` and the write surfaces beside it.
 *
 * ## Why this file is real rows and not a mock
 *
 * The suite this replaces asserted the Mongo FILTER OBJECT — `recipientId: { $in:
 * [...] }` — against a mocked `models/Notification`. Nothing reads that model any
 * more: every recipient-scoped query in `routes/notifications.ts` is
 * `inArray(notifications.recipientId, recipientIds)` against Postgres, so each of
 * those assertions was pointed at an abandoned store and could not fail for any
 * reason a user would notice. Here every recipient scope is observed through the
 * ROWS it did or did not reach, which is the same thing the operator sees.
 *
 * The recipient set itself is resolved for real, too: the route calls
 * `resolveNotificationInboxIds(userId, createUserScopedOxyServices(req))`, and
 * only the two foreign services under that (Oxy's account graph and the Redis
 * cache in front of it) are stubbed. So a viewer who operates no channel is
 * refused by the real predicate rather than by a mock told to answer differently.
 *
 * ## Two things are being defended, and the fixtures make the correct and the
 * broken implementation disagree on each
 *
 *  1. **THE WRITER'S ANONYMITY.** A channel post carries `written_by_oxy_user_id`,
 *     and `UserSettings.channel.signPosts` — decided server-side, on the post — is
 *     the WHOLE disclosure. A notification must not become a second door. Two
 *     shapes would open one: shipping the id on the payload, and routing by it (so
 *     the rows an operator receives partition the channel's posts by author). The
 *     fixtures give the channel TWO operators and give its post a writer who is one
 *     of them, which is exactly the arrangement where the two routings disagree —
 *     with a single operator, "everyone" and "the writer" produce the same page and
 *     neither test means anything. `WRITER_ID` is asserted PRESENT on the stored
 *     row the route reads before it is asserted absent from the response, so the
 *     leak check cannot pass by the fixture simply never carrying it.
 *
 *  2. **The scope reaches every recipient-filtered query.** A page the operator can
 *     see but not mark read, archive, delete or have counted is worse than no page
 *     at all, so each handler is checked against the STORED ROW it left behind —
 *     never against the status code alone, which a handler that answered 200 and
 *     wrote nothing would also satisfy.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { AccountMember, AccountNode } from '@oxyhq/core';

const mocks = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  getUserFollowing: vi.fn(),
  /** Oxy's account forest for one viewer — the only input to the real scope resolver. */
  listAccounts: vi.fn(),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => ({ getUserFollowing: mocks.getUserFollowing }),
  /**
   * The reader the route hands to `resolveNotificationInboxIds`. In production it
   * is an `OxyServices` bound to the CALLER's own bearer; the only thing that
   * matters here is that it is scoped to this request's viewer, so the stub keys
   * the forest off `req.user.id`.
   *
   * A module factory replaces the WHOLE module, so an export the route calls and
   * this factory omits is `undefined is not a function` on every request.
   */
  createUserScopedOxyServices: (req: { user?: { id?: string } }) => ({
    listAccounts: async () => mocks.listAccounts(req.user?.id),
  }),
  getServiceOxyClient: () => ({
    getUsersByIds: mocks.getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

/**
 * Redis, the cache in FRONT of the scope resolver — always a miss, so every
 * request re-resolves from the forest above and no test can be answered by an
 * entry an earlier one wrote.
 */
vi.mock('../../utils/redis', () => ({
  getRedisClient: () => ({
    isReady: true,
    get: async () => null,
    setEx: async () => 'OK',
  }),
  reportRedisConnectionFailure: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: vi.fn(async () => null),
    getUserFollowing: mocks.getUserFollowing,
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: (value: unknown) =>
    (Array.isArray(value) ? value : []).map((entry) => (entry as { id: string }).id),
  extractFollowersIds: vi.fn(() => []),
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
}));

vi.mock('../../utils/push', () => ({
  sendPushToUser: vi.fn(),
  formatPushForNotification: vi.fn(),
}));

import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres';
import { uuidv7 } from '@oxyhq/db';
import { notifications } from '../../db/schema/discovery';
import { muteWords } from '../../db/schema/engagement';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { clearPostScope, postScope, readPostRow, seedPost } from '../helpers/postFixtures';
import notificationsRouter from '../../routes/notifications';

const scope = postScope('notifications-channel-inbox');

/** One run tag, so parallel files and repeated runs cannot collide on an id. */
const run = randomUUID();
const OPERATOR_A = `oxy-operator-a-${run}`;
const OPERATOR_B = `oxy-operator-b-${run}`;
const OUTSIDER = `oxy-outsider-${run}`;
const CHANNEL = `oxy-channel-${run}`;
const ORGANIZATION = `oxy-org-${run}`;
const ACTOR = scope.user('actor');
const STRANGER = scope.user('stranger');

/**
 * The human who wrote the channel's post. A distinctive value on purpose: the
 * leak assertions search the serialized response for this exact string, so it has
 * to be one that could not appear for any other reason.
 */
const WRITER_ID = `oxy-writer-${run}`;

/** Every recipient id this file writes, for a teardown that touches nothing else. */
const RECIPIENTS = [OPERATOR_A, OPERATOR_B, OUTSIDER, CHANNEL];

const MUTED_TEXT = 'a kerfuffle, published here';
const STRANGER_TEXT = 'a kerfuffle elsewhere';

let db: Database;

/** The permission set Oxy derives for an owner — includes `account:act_as`. */
const OWNER_PERMISSIONS = ['account:read', 'account:update', 'account:act_as', 'members:read'];

function membership(accountId: string, memberUserId: string): AccountMember {
  return {
    _id: `member-${accountId}-${memberUserId}`,
    accountId,
    memberUserId,
    role: 'owner',
    permissions: OWNER_PERMISSIONS,
    inherit: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function node(
  accountId: string,
  kind: AccountNode['kind'],
  callerMembership: AccountMember | null,
): AccountNode {
  return {
    accountId,
    kind,
    parentAccountId: null,
    // Only `accountId`/`kind`/`callerMembership` are read; the DTO is filled in
    // enough to be a real node.
    account: {
      id: accountId,
      username: accountId,
      name: { displayName: accountId },
    } as AccountNode['account'],
    relationship: callerMembership ? 'member' : 'self',
    callerMembership,
  };
}

/**
 * What Oxy answers for one viewer.
 *
 * Both operators get the SAME channel plus an ORGANIZATION they may genuinely act
 * for — the one shape where "channels I operate" and "accounts I may act for"
 * disagree, so the kind filter in `listOperatedChannelIds` is exercised end to end
 * rather than assumed. {@link OUTSIDER} operates nothing.
 */
function forestFor(viewerId: string | undefined): AccountNode[] {
  if (viewerId !== OPERATOR_A && viewerId !== OPERATOR_B) {
    return [node(viewerId ?? '', 'personal', null)];
  }
  return [
    node(viewerId, 'personal', null),
    node(CHANNEL, 'channel', membership(CHANNEL, viewerId)),
    node(ORGANIZATION, 'organization', membership(ORGANIZATION, viewerId)),
  ];
}

interface Inbox {
  channelPostId: string;
  ownPostId: string;
  channelNotificationId: string;
  ownNotificationId: string;
}

async function seedReferencedPost(
  text: string,
  overrides: Partial<PostRecordInput> = {},
): Promise<string> {
  const owner = (overrides.oxyUserId ?? ACTOR) as string;
  const record = await seedPost(scope, {
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
    content: { variants: [{ source: 'author', text, tag: 'en' }] },
    ...overrides,
  });
  return record.id;
}

type NotificationType = 'like' | 'reply' | 'mention' | 'post';

async function seedNotification(
  recipientId: string,
  entityId: string,
  type: NotificationType = 'like',
  read = false,
): Promise<string> {
  const id = uuidv7();
  await db.insert(notifications).values({
    id,
    recipientId,
    actorId: ACTOR,
    type,
    entityType: 'post',
    entityId,
    read,
  });
  return id;
}

/**
 * The standard arrangement: somebody liked the CHANNEL's post (a row addressed to
 * the channel) and somebody liked OPERATOR_A's own post (a row addressed to the
 * person). The channel's post carries a writer, which is the fact the anonymity
 * cases are about.
 */
async function seedInbox(options: { writtenBy?: string; channelText?: string } = {}): Promise<Inbox> {
  const channelPostId = await seedReferencedPost(options.channelText ?? 'the channel published this', {
    oxyUserId: CHANNEL,
    authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
    writtenByOxyUserId: options.writtenBy ?? WRITER_ID,
  });
  const ownPostId = await seedReferencedPost('my own post', { oxyUserId: OPERATOR_A });

  return {
    channelPostId,
    ownPostId,
    channelNotificationId: await seedNotification(CHANNEL, channelPostId),
    ownNotificationId: await seedNotification(OPERATOR_A, ownPostId),
  };
}

interface WireNotification {
  _id: string;
  recipientId: string;
  preview?: string;
  post?: { id: string };
  recipientId_populated?: { _id: string; username: string; name: { displayName: string } };
}

interface NotificationsBody {
  notifications: WireNotification[];
  unreadCount: number;
}

function makeApp(viewerId: string, emitted: { event: string; payload: unknown }[] = []) {
  const app = express();
  app.use(express.json());
  app.set('notificationsNamespace', {
    to: () => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) }),
  });
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: string } }).user = { id: viewerId };
    next();
  });
  app.use('/', notificationsRouter);
  return app;
}

async function fetchPage(viewerId: string): Promise<NotificationsBody> {
  const res = await request(makeApp(viewerId)).get('/').expect(200);
  return res.body as NotificationsBody;
}

async function storedNotification(id: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
  return row;
}

function idsOf(body: NotificationsBody): string[] {
  return body.notifications.map((n) => n._id);
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAccounts.mockImplementation(async (viewerId: string | undefined) => forestFor(viewerId));
  mocks.getUsersByIds.mockResolvedValue([
    { id: ACTOR, username: 'liker', name: { displayName: 'A Liker' } },
    { id: CHANNEL, username: 'techweekly', name: { displayName: 'Tech Weekly' } },
  ]);
  mocks.getUserFollowing.mockResolvedValue([]);
});

afterEach(async () => {
  await db.delete(notifications).where(inArray(notifications.recipientId, RECIPIENTS));
  await db.delete(muteWords).where(inArray(muteWords.userId, RECIPIENTS));
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('fixture shape (vacuity floor)', () => {
  it('gives the channel more than one operator', () => {
    // With a single operator, "notify every operator" and "notify the writer"
    // produce the same page, and neither anonymity case below could tell them
    // apart.
    expect(OPERATOR_A).not.toBe(OPERATOR_B);
    expect(forestFor(OPERATOR_A).some((n) => n.accountId === CHANNEL)).toBe(true);
    expect(forestFor(OPERATOR_B).some((n) => n.accountId === CHANNEL)).toBe(true);
  });

  it('gives an operator an act-as-eligible account that is NOT a channel', () => {
    // The one shape where the kind filter changes the answer: without it, the
    // organization would expand into a person's inbox too and every scope
    // assertion below would still pass.
    const organization = forestFor(OPERATOR_A).find((n) => n.accountId === ORGANIZATION);
    expect(organization?.kind).toBe('organization');
    expect(organization?.callerMembership?.permissions).toContain('account:act_as');
  });

  it('gives the outsider no channel at all', () => {
    expect(forestFor(OUTSIDER).some((n) => n.kind === 'channel')).toBe(false);
  });

  it('puts a writer id on the STORED row the handler actually reads', async () => {
    // If this stops holding, every "does not leak the writer" assertion is
    // vacuous — it would be asserting the absence of something nothing had.
    const inbox = await seedInbox();
    const row = await readPostRow(inbox.channelPostId);
    expect(row?.writtenByOxyUserId).toBe(WRITER_ID);
  });

  it('uses a writer id that cannot appear in a response for any other reason', () => {
    // The leak check is a substring search over the serialized body, so the id
    // must not collide with an operator, the channel, or the actor — otherwise a
    // legitimate `recipientId`/`actorId` would fail it (or mask a real leak).
    expect([OPERATOR_A, OPERATOR_B, CHANNEL, ACTOR, OUTSIDER]).not.toContain(WRITER_ID);
  });
});

describe("GET /notifications — a channel operator's inbox", () => {
  it("returns the channel's rows beside the viewer's own", async () => {
    const inbox = await seedInbox();
    // Addressed to the OTHER operator personally — in nobody's scope but theirs,
    // so "the scope is wider" cannot be satisfied by returning everything.
    const outsidePostId = await seedReferencedPost('not for A', { oxyUserId: OPERATOR_B });
    const outsideNotificationId = await seedNotification(OPERATOR_B, outsidePostId);

    const body = await fetchPage(OPERATOR_A);

    expect(idsOf(body).sort()).toEqual(
      [inbox.channelNotificationId, inbox.ownNotificationId].sort(),
    );
    expect(idsOf(body)).not.toContain(outsideNotificationId);
    // Both rows are unread, and the aggregate is over the same scope as the page.
    expect(body.unreadCount).toBe(2);
  });

  it('never gives a viewer who operates no channel the channel’s rows', async () => {
    // The scope IS the authorization, and the outsider's is resolved by the real
    // predicate from a forest holding no channel.
    const inbox = await seedInbox();
    await seedNotification(OUTSIDER, inbox.ownPostId);

    const body = await fetchPage(OUTSIDER);

    expect(idsOf(body)).not.toContain(inbox.channelNotificationId);
    expect(body.notifications).toHaveLength(1);
  });

  it('names the channel on its rows and leaves the viewer’s own rows unmarked', async () => {
    const inbox = await seedInbox();

    const body = await fetchPage(OPERATOR_A);
    const channelRow = body.notifications.find((n) => n._id === inbox.channelNotificationId);
    const ownRow = body.notifications.find((n) => n._id === inbox.ownNotificationId);

    expect(channelRow?.recipientId_populated).toMatchObject({
      _id: CHANNEL,
      username: 'techweekly',
      name: { displayName: 'Tech Weekly' },
    });
    // Absence is the signal for "this one is mine" — populating it for the viewer
    // would make every row look like a channel's.
    expect(ownRow).not.toHaveProperty('recipientId_populated');
  });

  it('NEVER discloses who wrote the channel post', async () => {
    const inbox = await seedInbox();
    // A `post` notification carries the FULL hydrated DTO, which is the widest
    // surface the writer id could ride out on.
    const embedId = await seedNotification(CHANNEL, inbox.channelPostId, 'post');

    const body = await fetchPage(OPERATOR_A);
    const embedRow = body.notifications.find((n) => n._id === embedId);

    // Vacuity floor: the embed and the preview are genuinely present, so their
    // silence about the writer is a fact about the handler.
    expect(embedRow?.post).toMatchObject({ id: inbox.channelPostId });
    expect(embedRow?.preview).toBe('the channel published this');
    // Anywhere in the payload, under any key. `writtenByOxyUserId` is deliberately
    // absent from every DTO; a notification must not be the exception.
    expect(JSON.stringify(body)).not.toContain(WRITER_ID);
  });

  it('gives the writer and a non-writing operator the SAME page', async () => {
    // The one arrangement where "every operator" and "the writer" disagree: the
    // channel's post was written by OPERATOR_A, and OPERATOR_B wrote nothing.
    // Keyed on `written_by_oxy_user_id`, B's page would be missing the channel row
    // — and that ABSENCE would itself tell B that A wrote it.
    const inbox = await seedInbox({ writtenBy: OPERATOR_A });

    const asWriter = await fetchPage(OPERATOR_A);
    const asOther = await fetchPage(OPERATOR_B);

    const channelRowsFor = (body: NotificationsBody) =>
      body.notifications.filter((n) => n.recipientId === CHANNEL).map((n) => n._id);

    expect(channelRowsFor(asWriter)).toEqual([inbox.channelNotificationId]);
    expect(channelRowsFor(asOther)).toEqual(channelRowsFor(asWriter));
    // And B is told nothing about the writer by the payload either.
    expect(JSON.stringify(asOther)).not.toContain(WRITER_ID);
  });

  it("treats the channel's post as the operator's own work for the muted-word gate", async () => {
    // The post's owner is the CHANNEL, so `viewerState.isOwner` is false for a
    // person — without the operated-channel check the operator's own muted word
    // would silently delete their channel's engagement.
    //
    // The STRANGER's post is the control, and it is what makes this test able to
    // fail: it carries the same muted word and must be dropped. Without it, a mute
    // rule that never compiled would look exactly like a rule the channel row
    // correctly survived.
    const inbox = await seedInbox({ channelText: MUTED_TEXT });
    const strangerPostId = await seedReferencedPost(STRANGER_TEXT, { oxyUserId: STRANGER });
    const strangerNotificationId = await seedNotification(OPERATOR_A, strangerPostId);
    await db
      .insert(muteWords)
      .values({ userId: OPERATOR_A, value: 'kerfuffle', targets: ['content'], actorTarget: 'all' });

    const body = await fetchPage(OPERATOR_A);

    // The rule is live: it removed the stranger's row.
    expect(idsOf(body)).not.toContain(strangerNotificationId);
    // And it did NOT remove the operator's own channel's engagement.
    expect(idsOf(body)).toContain(inbox.channelNotificationId);
  });
});

describe('the write surfaces honour the same scope', () => {
  it('marks a channel notification read', async () => {
    const inbox = await seedInbox();
    const emitted: { event: string; payload: unknown }[] = [];

    const res = await request(makeApp(OPERATOR_A, emitted))
      .patch(`/${inbox.channelNotificationId}/read`)
      .expect(200);

    expect(res.body.notification._id).toBe(inbox.channelNotificationId);
    // The stored row, not the status: a handler that answered 200 and wrote
    // nothing would satisfy the status assertion alone.
    expect((await storedNotification(inbox.channelNotificationId)).read).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it('clears the channel rows on mark-all-read, or the badge never reaches zero', async () => {
    const inbox = await seedInbox();

    await request(makeApp(OPERATOR_A)).patch('/read-all').expect(200);

    expect((await storedNotification(inbox.channelNotificationId)).read).toBe(true);
    expect((await storedNotification(inbox.ownNotificationId)).read).toBe(true);
    expect((await fetchPage(OPERATOR_A)).unreadCount).toBe(0);
  });

  it('counts the channel rows in the unread badge', async () => {
    const inbox = await seedInbox();

    const counted = await request(makeApp(OPERATOR_A)).get('/unread-count').expect(200);

    // TWO: the viewer's own row and the channel's. Scoped to the viewer alone it
    // would be 1 — a badge that can never reach the number the list shows.
    expect(counted.body.count).toBe(2);

    await request(makeApp(OPERATOR_A)).patch(`/${inbox.channelNotificationId}/read`).expect(200);
    expect((await request(makeApp(OPERATOR_A)).get('/unread-count').expect(200)).body.count).toBe(1);
  });

  it('archives a channel notification', async () => {
    const inbox = await seedInbox();
    const emitted: { event: string; payload: unknown }[] = [];

    await request(makeApp(OPERATOR_A, emitted))
      .patch(`/${inbox.channelNotificationId}/archive`)
      .expect(200);

    expect((await storedNotification(inbox.channelNotificationId)).read).toBe(true);
    expect(emitted[0]).toEqual({
      event: 'notificationArchived',
      payload: inbox.channelNotificationId,
    });
  });

  it('deletes a channel notification', async () => {
    const inbox = await seedInbox();
    const emitted: { event: string; payload: unknown }[] = [];

    await request(makeApp(OPERATOR_A, emitted))
      .delete(`/${inbox.channelNotificationId}`)
      .expect(200);

    expect(await storedNotification(inbox.channelNotificationId)).toBeUndefined();
    expect(emitted[0]).toEqual({
      event: 'notificationDeleted',
      payload: inbox.channelNotificationId,
    });
  });

  it('refuses every write on a notification outside the scope, and leaves the row alone', async () => {
    // The scope IS the authorization: the outsider operates no channel, so the
    // same query finds nothing. Each refusal is checked against the row as well as
    // the status — a rejection that had ALSO written would pass on the status.
    const inbox = await seedInbox();
    const app = makeApp(OUTSIDER);

    await request(app).patch(`/${inbox.channelNotificationId}/read`).expect(404);
    await request(app).patch(`/${inbox.channelNotificationId}/archive`).expect(404);
    await request(app).delete(`/${inbox.channelNotificationId}`).expect(404);

    const stored = await storedNotification(inbox.channelNotificationId);
    expect(stored).toBeDefined();
    expect(stored.read).toBe(false);

    // Mark-all-read answers 200 for everyone; what matters is which rows it
    // touched. The outsider's own inbox is empty, so it must touch none.
    await request(app).patch('/read-all').expect(200);
    expect((await storedNotification(inbox.channelNotificationId)).read).toBe(false);
    expect((await storedNotification(inbox.ownNotificationId)).read).toBe(false);
  });
});
