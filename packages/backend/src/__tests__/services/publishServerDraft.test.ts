import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A SERVER DRAFT — a post stored with `status: 'draft'`, typically by an
 * automation through the API or MCP — going out through the same claim and the
 * same pipeline a scheduled post does.
 *
 * Three properties, each against real rows:
 *
 *  1. `create` DEFERS a draft's side effects the way it defers a scheduled
 *     post's. It used to run the notification fan-out at draft time, so the
 *     author of a post a draft replied to was told about a reply they could not
 *     open — and would be told again when it published.
 *  2. Publishing runs the pipeline exactly ONCE. The claim is the conditional
 *     `UPDATE … WHERE status = 'draft'`, so a second publish (another device,
 *     a double tap) matches nothing.
 *  3. What the draft carried survives the publish untouched: the author's
 *     language variants, the lane, the sources and the collaborator invite.
 *
 * The notification writers, the MTN emitter and the federator are stubbed at the
 * module boundary: what they DO is covered by their own suites, and here only
 * whether and how often they are reached matters.
 */

const hoisted = vi.hoisted(() => ({
  createPostAuthorNotifications: vi.fn(async () => undefined),
  createMentionNotifications: vi.fn(async () => undefined),
  createBatchNotifications: vi.fn(async () => undefined),
  createNotification: vi.fn(async () => undefined),
  emitPostCreated: vi.fn(async () => undefined),
  federateNewPost: vi.fn(async () => undefined),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: hoisted.createNotification,
  createMentionNotifications: hoisted.createMentionNotifications,
  createBatchNotifications: hoisted.createBatchNotifications,
  createPostAuthorNotifications: hoisted.createPostAuthorNotifications,
}));
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: hoisted.emitPostCreated,
  emitRepostCreated: vi.fn(async () => undefined),
}));
vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost: hoisted.federateNewPost }),
  registerPostCreator: vi.fn(),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById: vi.fn(async (id: string) => ({ id, username: 'author' })),
    getUsersByIds: vi.fn(async () => []),
  }),
}));
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../services/postEnrichment', () => ({ enrichIngestedPosts: vi.fn() }));
vi.mock('../../services/MediaMetadataService', () => ({
  mediaMetadataService: { enrichFromOxy: vi.fn(async (media: unknown[]) => media) },
  readPersistedMediaFields: vi.fn(() => ({})),
}));

import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { loadPostRecord } from '../../db/posts/postRepository';
import { drainBackgroundWork } from '../../runtime/backgroundWork';
import { postCollaborationService } from '../../services/PostCollaborationService';
import { postCreationService } from '../../services/PostCreationService';
import { clearPostScope, postScope, readPostRow, seedLane, seedPost, track } from '../helpers/postFixtures';

const scope = postScope('publish-server-draft');
const AUTHOR = scope.user('author');
const COLLABORATOR = scope.user('collaborator');
const STRANGER = scope.user('stranger');

const VARIANTS = [
  { source: 'author' as const, tag: 'en', text: 'Release notes for 4.2' },
  { source: 'author' as const, tag: 'es', text: 'Notas de la versión 4.2' },
];
const SOURCES = [{ url: 'https://example.com/changelog', title: 'Changelog' }];

/** A draft as `POST /posts` with `status: 'draft'` stores it. */
async function createDraft(params: Record<string, unknown> = {}): Promise<string> {
  const post = await postCreationService.create({
    oxyUserId: AUTHOR,
    content: { variants: VARIANTS, sources: SOURCES },
    visibility: PostVisibility.PUBLIC,
    status: 'draft',
    skipSocketEmit: true,
    ...params,
  } as Parameters<typeof postCreationService.create>[0]);
  track(scope, post.id);
  return post.id;
}

/** Everything the notification fan-out writes is detached; wait for it. */
async function settle(): Promise<void> {
  await drainBackgroundWork(10_000);
}

const notifyInvites = vi.spyOn(postCollaborationService, 'notifyPendingInvites');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await settle();
  await clearPostScope(scope);
});

afterAll(async () => {
  notifyInvites.mockRestore();
  await closePostgres();
});

describe('a server draft at creation', () => {
  it('notifies nobody, emits nothing and federates nothing', async () => {
    const parent = await seedPost(scope, { oxyUserId: STRANGER });

    await createDraft({
      content: { text: 'A reply I have not sent yet' },
      parentPostId: parent.id,
    });
    await settle();

    // The reply notification is the one that used to go out at draft time.
    expect(hoisted.createPostAuthorNotifications).not.toHaveBeenCalled();
    expect(hoisted.emitPostCreated).not.toHaveBeenCalled();
    expect(hoisted.federateNewPost).not.toHaveBeenCalled();
  });
});

describe('publishing a server draft', () => {
  it('publishes once, through the scheduled pipeline, and keeps what the draft carried', async () => {
    const laneId = await seedLane(scope, { ownerId: AUTHOR });
    const postId = await createDraft({ laneId, collaboratorIds: [COLLABORATOR] });
    await settle();
    expect(notifyInvites).not.toHaveBeenCalled();

    const published = await postCreationService.claimAndPublishScheduledPost({
      postId,
      ownerId: AUTHOR,
      from: 'draft',
    });
    await settle();

    expect(published).not.toBeNull();
    // The invite goes out now that there is something to be invited to, and the
    // MTN record is written at the publish moment.
    expect(notifyInvites).toHaveBeenCalledTimes(1);
    expect(hoisted.emitPostCreated).toHaveBeenCalledTimes(1);
    // A pending collaborator still defers federation, exactly as for a
    // scheduled post: the invitee has not consented to the fediverse yet.
    expect(hoisted.federateNewPost).not.toHaveBeenCalled();

    const stored = await loadPostRecord(postId);
    expect(stored?.status).toBe('published');
    expect(stored?.laneId).toBe(laneId);
    expect(stored?.content.sources).toEqual(SOURCES);
    expect(stored?.content.variants?.map(({ tag, text, source }) => ({ tag, text, source })))
      .toEqual(VARIANTS);
    expect(stored?.authorship).toEqual(expect.arrayContaining([
      expect.objectContaining({ oxyUserId: COLLABORATOR, role: 'collaborator', status: 'pending' }),
    ]));
  });

  it('federates a draft with nobody left to consent', async () => {
    const postId = await createDraft();

    await postCreationService.claimAndPublishScheduledPost({ postId, ownerId: AUTHOR, from: 'draft' });
    await settle();

    expect(hoisted.federateNewPost).toHaveBeenCalledTimes(1);
  });

  it('runs the pipeline ONCE when the same draft is published twice at the same moment', async () => {
    const postId = await createDraft();

    const results = await Promise.all([
      postCreationService.claimAndPublishScheduledPost({ postId, ownerId: AUTHOR, from: 'draft' }),
      postCreationService.claimAndPublishScheduledPost({ postId, ownerId: AUTHOR, from: 'draft' }),
    ]);
    await settle();

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(hoisted.emitPostCreated).toHaveBeenCalledTimes(1);
  });

  it('refuses a second publish of a draft that already went out', async () => {
    const postId = await createDraft();
    await postCreationService.claimAndPublishScheduledPost({ postId, ownerId: AUTHOR, from: 'draft' });

    const again = await postCreationService.claimAndPublishScheduledPost({
      postId,
      ownerId: AUTHOR,
      from: 'draft',
    });

    expect(again).toBeNull();
    expect(hoisted.emitPostCreated).toHaveBeenCalledTimes(1);
  });

  it("refuses another user's draft and leaves it a draft", async () => {
    const postId = await createDraft();

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId,
      ownerId: STRANGER,
      from: 'draft',
    });

    expect(result).toBeNull();
    expect((await readPostRow(postId))?.status).toBe('draft');
  });

  it('dates the published post from its publication, not from when it was drafted', async () => {
    const draftedAt = new Date('2026-01-05T09:00:00.000Z');
    const draft = await seedPost(scope, { oxyUserId: AUTHOR, status: 'draft', createdAt: draftedAt });

    const before = Date.now();
    await postCreationService.claimAndPublishScheduledPost({
      postId: draft.id,
      ownerId: AUTHOR,
      from: 'draft',
    });

    const createdAt = (await readPostRow(draft.id))?.createdAt;
    expect(createdAt?.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('the claim takes a post out of ONE state only', () => {
  it('never lets the sweep, which names no state, publish a draft', async () => {
    const postId = await createDraft();

    const result = await postCreationService.claimAndPublishScheduledPost({ postId });

    expect(result).toBeNull();
    expect((await readPostRow(postId))?.status).toBe('draft');
  });

  it('never lets a draft publish reach a scheduled post', async () => {
    const scheduled = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId: scheduled.id,
      ownerId: AUTHOR,
      from: 'draft',
    });

    expect(result).toBeNull();
    expect((await readPostRow(scheduled.id))?.status).toBe('scheduled');
  });
});
