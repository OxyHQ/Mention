import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A channel's notifications, at the surface an operator actually reads.
 *
 * `notificationInboxScope.test.ts` pins WHO the recipients are; this suite pins
 * what that means for `GET /notifications` and the write surfaces beside it. Two
 * things are being defended, and the fixtures are built so that the correct and
 * the broken implementation disagree on each:
 *
 *  1. **THE WRITER'S ANONYMITY.** A channel post carries `writtenByOxyUserId`, and
 *     `UserSettings.channel.signPosts` — decided server-side, on the post — is the
 *     WHOLE disclosure. A notification must not become a second door. Two shapes
 *     would open one: shipping the id on the payload, and routing by it (so the
 *     rows an operator receives partition the channel's posts by author). The
 *     fixtures below give the channel TWO operators and give its post a writer who
 *     is one of them, which is exactly the arrangement where the two routings
 *     disagree — with a single operator, "everyone" and "the writer" produce the
 *     same page and neither test means anything. `WRITER_ID` is asserted PRESENT
 *     on the row the route reads before it is asserted absent from the response,
 *     so the leak check cannot pass by the fixture simply never carrying it.
 *
 *  2. **The scope reaches every recipient-filtered query.** A page the operator
 *     can see but not mark read, delete or have counted is worse than no page at
 *     all, so each handler is checked against the query it actually issued.
 */

const mocks = vi.hoisted(() => ({
  notificationFind: vi.fn(),
  notificationCountDocuments: vi.fn(),
  notificationFindOneAndUpdate: vi.fn(),
  notificationFindOneAndDelete: vi.fn(),
  notificationUpdateMany: vi.fn(),
  postFind: vi.fn(),
  hydratePosts: vi.fn(),
  getUsersByIds: vi.fn(),
  createScopedOxyClient: vi.fn(),
  loadShowSensitiveContent: vi.fn(),
  loadMuteWords: vi.fn(),
  resolveNotificationInboxIds: vi.fn(),
}));

vi.mock('../../services/safety/viewerSafety', () => ({
  loadShowSensitiveContent: mocks.loadShowSensitiveContent,
  loadMuteWords: mocks.loadMuteWords,
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../models/Notification', () => ({
  default: {
    find: mocks.notificationFind,
    countDocuments: mocks.notificationCountDocuments,
    findOneAndUpdate: mocks.notificationFindOneAndUpdate,
    findOneAndDelete: mocks.notificationFindOneAndDelete,
    updateMany: mocks.notificationUpdateMany,
  },
}));

vi.mock('../../models/Post', () => ({
  default: { find: mocks.postFind },
}));

vi.mock('../../models/PushToken', () => ({
  default: { deleteOne: vi.fn(), findOneAndUpdate: vi.fn() },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: mocks.hydratePosts },
}));

vi.mock('../../services/notificationInbox', () => ({
  resolveNotificationInboxIds: mocks.resolveNotificationInboxIds,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: mocks.createScopedOxyClient,
  createUserScopedOxyServices: () => ({ listAccounts: async () => [] }),
  getServiceOxyClient: () => ({ getUsersByIds: mocks.getUsersByIds }),
}));

vi.mock('../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (value?: string) => value,
}));

vi.mock('../../utils/push', () => ({ sendPushToUser: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import notificationsRouter from '../../routes/notifications';
// Imported for its TYPE only, so a mute fixture with the wrong field name is a
// compile error rather than a rule that silently never compiles (which is
// indistinguishable from a rule the row correctly survived).
import type { MuteWordRule } from '../../services/safety/muteWordMatcher';

const OPERATOR_A = 'operator-a';
const OPERATOR_B = 'operator-b';
const CHANNEL = 'channel-1';
const ACTOR = 'actor-1';
const STRANGER = 'stranger-author';

/**
 * The human who wrote the channel's post. A distinctive value on purpose: the
 * leak assertions search the serialized response for this exact string, so it has
 * to be one that could not appear for any other reason.
 */
const WRITER_ID = 'writer-6981c9178fcdefaf81988ffb';

const CHANNEL_POST_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const OWN_POST_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439013');
const STRANGER_POST_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439015');
const CHANNEL_NOTIFICATION_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
const OWN_NOTIFICATION_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439014');
const STRANGER_NOTIFICATION_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439016');

/** Somebody liked the CHANNEL's post: the row is addressed to the channel. */
function channelNotificationRow() {
  return {
    _id: CHANNEL_NOTIFICATION_ID,
    recipientId: CHANNEL,
    actorId: ACTOR,
    type: 'like',
    entityType: 'post',
    entityId: CHANNEL_POST_ID,
    read: false,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  };
}

/** Somebody liked the OPERATOR's own post: addressed to the person. */
function personalNotificationRow(viewerId: string) {
  return {
    _id: OWN_NOTIFICATION_ID,
    recipientId: viewerId,
    actorId: ACTOR,
    type: 'like',
    entityType: 'post',
    entityId: OWN_POST_ID,
    read: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/**
 * A reply on a STRANGER's post, addressed to the viewer personally — the control
 * for the muted-word case, where it must be dropped while the channel's row is
 * kept.
 */
function strangerNotificationRow() {
  return {
    _id: STRANGER_NOTIFICATION_ID,
    recipientId: OPERATOR_A,
    actorId: ACTOR,
    type: 'like' as const,
    entityType: 'post',
    entityId: STRANGER_POST_ID,
    read: false,
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
  };
}

function mockNotificationPage(rows: ReturnType<typeof channelNotificationRow>[]) {
  const lean = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ lean });
  const sort = vi.fn().mockReturnValue({ limit });
  mocks.notificationFind.mockReturnValue({ sort });
  mocks.notificationCountDocuments.mockResolvedValue(rows.length);
}

/**
 * The RAW post rows the route reads. The channel's post carries
 * `writtenByOxyUserId`, which is the whole point: the writer id is genuinely in
 * the data the handler touches, so its absence from the response is a fact about
 * the handler and not about the fixture.
 */
function mockRawPosts(writtenBy: string = WRITER_ID) {
  const lean = vi.fn().mockResolvedValue([
    {
      _id: CHANNEL_POST_ID,
      oxyUserId: CHANNEL,
      writtenByOxyUserId: writtenBy,
      content: { variants: [{ type: 'author', text: 'the channel published this' }] },
      visibility: 'public',
      status: 'published',
    },
    {
      _id: OWN_POST_ID,
      oxyUserId: OPERATOR_A,
      content: { variants: [{ type: 'author', text: 'my own post' }] },
      visibility: 'public',
      status: 'published',
    },
  ]);
  mocks.postFind.mockReturnValue({ lean });
}

function makeApp(viewerId: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: string } }).user = { id: viewerId };
    next();
  });
  app.use('/', notificationsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // BOTH operators resolve the SAME scope — the set is a property of the channel.
  mocks.resolveNotificationInboxIds.mockImplementation(async (viewerId: string) => [viewerId, CHANNEL]);
  mocks.getUsersByIds.mockResolvedValue([
    { id: ACTOR, username: 'liker', name: { displayName: 'A Liker' } },
    { id: CHANNEL, username: 'techweekly', name: { displayName: 'Tech Weekly' } },
  ]);
  mocks.createScopedOxyClient.mockReturnValue({ scope: 'viewer' });
  mocks.loadShowSensitiveContent.mockResolvedValue(false);
  mocks.loadMuteWords.mockResolvedValue([]);
  mocks.hydratePosts.mockResolvedValue([
    { id: String(CHANNEL_POST_ID), content: { text: 'the channel published this' }, user: { id: CHANNEL } },
    { id: String(OWN_POST_ID), content: { text: 'my own post' }, user: { id: OPERATOR_A } },
  ]);
  mockNotificationPage([channelNotificationRow(), personalNotificationRow(OPERATOR_A)]);
  mockRawPosts();
});

describe('fixture shape (vacuity floor)', () => {
  it('gives the channel more than one operator', () => {
    // With a single operator, "notify every operator" and "notify the writer"
    // produce the same page, and neither anonymity case below could tell them
    // apart.
    expect(OPERATOR_A).not.toBe(OPERATOR_B);
  });

  it('puts a writer id on the row the handler actually reads', async () => {
    // If this stops holding, every "does not leak the writer" assertion is
    // vacuous — it would be asserting the absence of something nothing had.
    const posts = await mocks.postFind().lean();
    expect(JSON.stringify(posts)).toContain(WRITER_ID);
  });

  it('uses a writer id that cannot appear in a response for any other reason', () => {
    // The leak check is a substring search over the serialized body, so the id
    // must not collide with an operator, the channel, or the actor — otherwise a
    // legitimate `recipientId`/`actorId` would fail it (or mask a real leak).
    expect([OPERATOR_A, OPERATOR_B, CHANNEL, ACTOR]).not.toContain(WRITER_ID);
  });
});

describe("GET /notifications — a channel operator's inbox", () => {
  it('queries every recipient id the scope covers, not just the viewer', async () => {
    await request(makeApp(OPERATOR_A)).get('/').expect(200);

    expect(mocks.notificationFind).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: { $in: [OPERATOR_A, CHANNEL] } }),
    );
    expect(mocks.notificationCountDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: { $in: [OPERATOR_A, CHANNEL] }, read: false }),
    );
  });

  it('names the channel on its rows and leaves the viewer’s own rows unmarked', async () => {
    const response = await request(makeApp(OPERATOR_A)).get('/').expect(200);

    const channelRow = response.body.notifications.find(
      (n: { _id: string }) => n._id === String(CHANNEL_NOTIFICATION_ID),
    );
    const ownRow = response.body.notifications.find(
      (n: { _id: string }) => n._id === String(OWN_NOTIFICATION_ID),
    );

    expect(channelRow.recipientId_populated).toMatchObject({
      _id: CHANNEL,
      username: 'techweekly',
      name: { displayName: 'Tech Weekly' },
    });
    // Absence is the signal for "this one is mine" — populating it for the viewer
    // would make every row look like a channel's.
    expect(ownRow).not.toHaveProperty('recipientId_populated');
  });

  it('NEVER discloses who wrote the channel post', async () => {
    const response = await request(makeApp(OPERATOR_A)).get('/').expect(200);

    // Anywhere in the payload, under any key. `writtenByOxyUserId` is deliberately
    // absent from every DTO; a notification must not be the exception.
    expect(JSON.stringify(response.body)).not.toContain(WRITER_ID);
  });

  it('gives the writer and a non-writing operator the SAME page', async () => {
    // The one arrangement where "every operator" and "the writer" disagree: the
    // channel's post was written by OPERATOR_A, and OPERATOR_B wrote nothing.
    // Keyed on `writtenByOxyUserId`, B's page would be missing the channel row —
    // and that ABSENCE would itself tell B that A wrote it.
    mockRawPosts(OPERATOR_A);

    const asWriter = await request(makeApp(OPERATOR_A)).get('/').expect(200);
    const asOther = await request(makeApp(OPERATOR_B)).get('/').expect(200);

    const channelRowsFor = (body: { notifications: { _id: string; recipientId: string }[] }) =>
      body.notifications.filter((n) => n.recipientId === CHANNEL).map((n) => n._id);

    expect(channelRowsFor(asWriter.body)).toEqual([String(CHANNEL_NOTIFICATION_ID)]);
    expect(channelRowsFor(asOther.body)).toEqual(channelRowsFor(asWriter.body));
  });

  it("treats the channel's post as the operator's own work for the muted-word gate", async () => {
    // The post's owner is the CHANNEL, so `viewerState.isOwner` is false for a
    // person — without the operated-channel check the operator's own muted word
    // would silently delete their channel's engagement.
    //
    // The STRANGER's post is the control, and it is what makes this test able to
    // fail: it carries the same muted word and must be dropped. Without it, a
    // mute rule that never compiled (a wrong field name is enough) would look
    // exactly like a rule the channel row correctly survived.
    const muted: MuteWordRule[] = [
      { value: 'kerfuffle', targets: ['content'], actorTarget: 'all' },
    ];
    mocks.loadMuteWords.mockResolvedValue(muted);
    mockNotificationPage([
      channelNotificationRow(),
      strangerNotificationRow(),
      personalNotificationRow(OPERATOR_A),
    ]);
    mocks.hydratePosts.mockResolvedValue([
      { id: String(CHANNEL_POST_ID), content: { text: 'a kerfuffle, published here' }, user: { id: CHANNEL } },
      { id: String(STRANGER_POST_ID), content: { text: 'a kerfuffle elsewhere' }, user: { id: STRANGER } },
      { id: String(OWN_POST_ID), content: { text: 'my own post' }, user: { id: OPERATOR_A } },
    ]);

    const response = await request(makeApp(OPERATOR_A)).get('/').expect(200);
    const ids = response.body.notifications.map((n: { _id: string }) => n._id);

    // The rule is live: it removed the stranger's row.
    expect(ids).not.toContain(String(STRANGER_NOTIFICATION_ID));
    // And it did NOT remove the operator's own channel's engagement.
    expect(ids).toContain(String(CHANNEL_NOTIFICATION_ID));
  });
});

describe('the write surfaces honour the same scope', () => {
  it('marks a channel notification read', async () => {
    mocks.notificationFindOneAndUpdate.mockResolvedValue({
      _id: CHANNEL_NOTIFICATION_ID,
      actorId: ACTOR,
      toObject: () => ({ _id: CHANNEL_NOTIFICATION_ID, actorId: ACTOR }),
    });

    const app = makeApp(OPERATOR_A);
    app.set('notificationsNamespace', { to: () => ({ emit: () => undefined }) });

    await request(app).patch(`/${CHANNEL_NOTIFICATION_ID}/read`).expect(200);

    expect(mocks.notificationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: { $in: [OPERATOR_A, CHANNEL] } }),
      { read: true },
      { new: true },
    );
  });

  it('clears the channel rows on mark-all-read, or the badge never reaches zero', async () => {
    mocks.notificationUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    const app = makeApp(OPERATOR_A);
    app.set('notificationsNamespace', { to: () => ({ emit: () => undefined }) });

    await request(app).patch('/read-all').expect(200);

    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith(
      { recipientId: { $in: [OPERATOR_A, CHANNEL] } },
      { read: true },
    );
  });

  it('counts the channel rows in the unread badge', async () => {
    mocks.notificationCountDocuments.mockResolvedValue(3);

    const response = await request(makeApp(OPERATOR_A)).get('/unread-count').expect(200);

    expect(response.body.count).toBe(3);
    expect(mocks.notificationCountDocuments).toHaveBeenCalledWith({
      recipientId: { $in: [OPERATOR_A, CHANNEL] },
      read: false,
    });
  });

  it('deletes a channel notification', async () => {
    mocks.notificationFindOneAndDelete.mockResolvedValue({ _id: CHANNEL_NOTIFICATION_ID });

    const app = makeApp(OPERATOR_A);
    app.set('notificationsNamespace', { to: () => ({ emit: () => undefined }) });

    await request(app).delete(`/${CHANNEL_NOTIFICATION_ID}`).expect(200);

    expect(mocks.notificationFindOneAndDelete).toHaveBeenCalledWith({
      _id: String(CHANNEL_NOTIFICATION_ID),
      recipientId: { $in: [OPERATOR_A, CHANNEL] },
    });
  });

  it('refuses a notification outside the scope', async () => {
    // The scope IS the authorization: a stranger's id resolves to their own inbox
    // only, so the same query finds nothing.
    mocks.resolveNotificationInboxIds.mockImplementation(async (viewerId: string) => [viewerId]);
    mocks.notificationFindOneAndDelete.mockResolvedValue(null);

    await request(makeApp('stranger-1')).delete(`/${CHANNEL_NOTIFICATION_ID}`).expect(404);

    expect(mocks.notificationFindOneAndDelete).toHaveBeenCalledWith({
      _id: String(CHANNEL_NOTIFICATION_ID),
      recipientId: { $in: ['stranger-1'] },
    });
  });
});
