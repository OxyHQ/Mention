import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A trailing block of 4+ hashtags is stripped from what a native post STORES.
 *
 * This behaviour used to live in the `Post` schema's Mongoose `pre('validate')`
 * hook, which ran on `.save()` — and `.save()` is how both native write paths
 * persisted a post until the Postgres cutover (`new Post(...).save()` in
 * `PostCreationService`, `post.save()` in `updatePost`). So it fired on every
 * native create and every native edit for as long as the store was Mongo; it is
 * a behaviour that was LOST, not a validator that never ran. The federated
 * ingest never went through the hook (`apPostContent.ts` calls
 * `normalizePostHashtags` itself), which is why the gap presented as Mention
 * cleaning other instances' bodies while storing its own users' verbatim.
 *
 * What is asserted here, and why each case earns its place:
 *  - the CREATE half (`toStoredContent`) and the EDIT half (`updatePost`) are two
 *    separate calls, so each needs its own case or half the surface is uncovered;
 *  - the `hashtags` COLUMN keeps every tag the strip removed from view — losing a
 *    tag would take the post out of its own hashtag feed, which is the failure
 *    this normalization has always been careful to avoid;
 *  - three consecutive hashtags stay VISIBLE (the threshold is a threshold, and a
 *    test that only checks the stripping direction cannot tell a working rule from
 *    one that eats every hashtag);
 *  - an edit that does not touch the body rewrites NOTHING — the Mongoose hook was
 *    guarded by `isModified('content.variants')` and dropping that guard would let
 *    a media-only edit silently rewrite an author's words years later.
 *
 * Every assertion reads the row back through `readPost`, so it measures what the
 * database HOLDS rather than what a service assembled.
 */

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost: vi.fn().mockResolvedValue(undefined) }),
  registerPostCreator: vi.fn(),
}));

const hoisted = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  resolveUserSummaries: vi.fn(),
  resolveCollaboratorRefs: vi.fn(),
  attachCollaborators: vi.fn(),
  autoAcceptInvites: vi.fn(),
  notifyPendingInvites: vi.fn(),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: hoisted.resolveUserSummaries,
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

vi.mock('../../services/PostCollaborationService', () => ({
  postCollaborationService: {
    resolveCollaboratorRefs: hoisted.resolveCollaboratorRefs,
    attachCollaborators: hoisted.attachCollaborators,
    autoAcceptInvites: hoisted.autoAcceptInvites,
    notifyPendingInvites: hoisted.notifyPendingInvites,
    buildAuthorship: (ownerId: string) => [{ oxyUserId: ownerId, role: 'owner', status: 'accepted' }],
  },
  CollabValidationError: class extends Error {},
  CollabStateError: class extends Error {},
}));

// The MTN dual-write is a best-effort side effect with a batched Oxy asset
// lookup inside it. Nothing here is about the chain.
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn().mockResolvedValue(undefined),
  emitTombstone: vi.fn().mockResolvedValue(undefined),
  postRecordUri: () => 'at://test',
}));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

// Spread the real module: `PostCreationService` and `controllers/posts` need
// three different helpers out of it, and other modules in this graph import
// others still.
vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({ getUsersByIds: vi.fn().mockResolvedValue([]) }),
  createScopedOxyClient: () => undefined,
  createUserScopedOxyServices: () => undefined,
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearServiceScope,
  readPost,
  seedPost,
  serviceScope,
  trackPost,
  withDeadlockRetry,
} from '../helpers/serviceFixtures';
import { postCreationService } from '../../services/PostCreationService';
import { updatePost } from '../../controllers/posts/updatePost';
import { stripSpamHashtagBlocks } from '../../services/postVariants';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = serviceScope('post-spam-hashtag-strip');

async function createAndReload(
  params: Parameters<typeof postCreationService.create>[0],
): Promise<PostRecord> {
  const created = await withDeadlockRetry(() => postCreationService.create(params));
  trackPost(scope, created.id);
  const stored = await readPost(created.id);
  if (!stored) throw new Error(`post ${created.id} was not readable after create`);
  return stored;
}

function buildResponse() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

/** Edit an existing post through the real controller, inside the edit window. */
async function edit(postId: string, userId: string, body: Record<string, unknown>) {
  const { res, captured } = buildResponse();
  hoisted.hydratePosts.mockImplementation(async () => [{ id: postId }]);
  await updatePost(
    {
      params: { id: postId },
      query: {},
      headers: {},
      acceptsLanguages: () => [] as string[],
      body,
      user: { id: userId },
    } as never,
    res as never,
  );
  return captured;
}

const bodyOf = (post: PostRecord | undefined, index = 0): string | undefined =>
  post?.content.variants?.[index]?.text;

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.resolveCollaboratorRefs.mockResolvedValue(undefined);
  await clearServiceScope(scope);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('a native post is stored without its trailing hashtag block — CREATE', () => {
  it('keeps the first tag of a block that follows real text, and drops the rest', async () => {
    const post = await createAndReload({
      oxyUserId: scope.user('author'),
      content: { text: 'Shipping the new feed today. #startup #social #tech #ai #growth' },
      hashtags: ['startup', 'social', 'tech', 'ai', 'growth'],
      skipSocketEmit: true,
    });

    expect(bodyOf(post)).toBe('Shipping the new feed today. #startup');
    // Every tag survives in the column even though four left the body: the post
    // still belongs in all five hashtag feeds.
    expect(post.hashtags).toEqual(['startup', 'social', 'tech', 'ai', 'growth']);
  });

  it('drops a block with nothing in front of it entirely', async () => {
    const post = await createAndReload({
      oxyUserId: scope.user('author'),
      content: { text: '#startup #social #tech #ai #growth' },
      hashtags: ['startup', 'social', 'tech', 'ai', 'growth'],
      skipSocketEmit: true,
    });

    expect(bodyOf(post)).toBe('');
    expect(post.hashtags).toEqual(['startup', 'social', 'tech', 'ai', 'growth']);
  });

  it('leaves THREE consecutive hashtags alone — the threshold is a threshold', async () => {
    const post = await createAndReload({
      oxyUserId: scope.user('author'),
      content: { text: 'Testing categories #design #product #ux' },
      hashtags: ['design', 'product', 'ux'],
      skipSocketEmit: true,
    });

    expect(bodyOf(post)).toBe('Testing categories #design #product #ux');
  });

  it('cleans every author rendition, not just the primary', async () => {
    const post = await createAndReload({
      oxyUserId: scope.user('author'),
      content: {
        variants: [
          { tag: 'en', source: 'author', text: 'Shipping today. #a #b #c #d' },
          { tag: 'es', source: 'author', text: 'Lanzamos hoy. #uno #dos #tres #cuatro' },
        ],
      },
      hashtags: [],
      skipSocketEmit: true,
    });

    expect(bodyOf(post, 0)).toBe('Shipping today. #a');
    expect(bodyOf(post, 1)).toBe('Lanzamos hoy. #uno');
  });
});

describe('a native post is stored without its trailing hashtag block — EDIT', () => {
  it('cleans a block the edit introduced', async () => {
    const author = scope.user('editor');
    const seeded = await seedPost(scope, {
      oxyUserId: author,
      status: 'published',
      createdAt: new Date(),
      content: { variants: [{ tag: 'en', source: 'author', text: 'original' }] },
    });

    const captured = await edit(seeded.id, author, {
      content: { text: 'Shipping the new feed today. #startup #social #tech #ai #growth' },
    });

    expect(captured.status).toBeUndefined();
    const stored = await readPost(seeded.id);
    expect(bodyOf(stored)).toBe('Shipping the new feed today. #startup');
    expect(stored?.hashtags).toEqual(['startup', 'social', 'tech', 'ai', 'growth']);
  });

  it('rewrites NOTHING when the edit did not touch the body', async () => {
    // Seeded straight into the table with a block already in it — the shape a
    // post written before this rule existed, or imported, actually has. The
    // Mongoose hook was guarded by `isModified('content.variants')`; without the
    // equivalent guard a settings-only edit would silently rewrite the author's
    // words, so this is the case that pins the placement rather than the rule.
    const author = scope.user('settings-editor');
    const seeded = await seedPost(scope, {
      oxyUserId: author,
      status: 'published',
      createdAt: new Date(),
      content: { variants: [{ tag: 'en', source: 'author', text: 'Old post. #a #b #c #d' }] },
    });

    const captured = await edit(seeded.id, author, { reviewReplies: true });

    expect(captured.status).toBeUndefined();
    const stored = await readPost(seeded.id);
    expect(bodyOf(stored)).toBe('Old post. #a #b #c #d');
  });
});

describe('stripSpamHashtagBlocks', () => {
  it('never touches a MACHINE rendition — a translation comes from the cleaned primary', () => {
    const [author, machine] = stripSpamHashtagBlocks([
      { source: 'author', text: 'Shipping today. #a #b #c #d' },
      { source: 'machine', tag: 'es', text: 'Lanzamos hoy. #a #b #c #d' },
    ]);

    expect(author?.text).toBe('Shipping today. #a');
    expect(machine?.text).toBe('Lanzamos hoy. #a #b #c #d');
  });

  it('is idempotent — a body already cleaned on ingest passes through unchanged', () => {
    const once = stripSpamHashtagBlocks([{ source: 'author', text: 'Shipping today. #a #b #c #d' }]);
    const twice = stripSpamHashtagBlocks(once);

    expect(twice[0]?.text).toBe('Shipping today. #a');
    // The same object, not an equal copy: an unchanged rendition is returned as-is.
    expect(twice[0]).toBe(once[0]);
  });
});
