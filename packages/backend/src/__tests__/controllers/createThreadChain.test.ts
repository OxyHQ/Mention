import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for {@link createThread}'s sequential-chain linkage.
 *
 * A multi-post thread must be linked as a CHAIN (post2 → post1 → post0), not a
 * flat FAN where every continuation replies to the first post. Each continuation
 * post's `parent_post_id` must point at the IMMEDIATELY-previous post, while
 * every post shares one `thread_id` equal to the FIRST (root) post's id. That is
 * what makes a self-authored thread render sequentially, what lets
 * `ThreadSlicingService` recognise the root, and what gives federation and
 * notifications the correct `inReplyTo`.
 *
 * ## What changed with the Postgres port
 *
 * The old suite replaced `PostCreationService` with a stub that constructed a
 * Mongoose `Post` and never saved it, then asserted on the fields of the objects
 * the controller happened to push into its response. Every link it checked was a
 * property of an in-memory document; nothing proved a row existed, that the two
 * link columns were written, or — most of all — that they SURVIVE, since
 * `parent_post_id` and `thread_id` are real foreign keys with `ON DELETE SET
 * NULL` and a value pointing at nothing would be silently nulled.
 *
 * This runs the REAL creation service against Postgres and reads the chain back
 * out of the table. Hydration is a passthrough so the response is still
 * inspectable, but every linkage assertion is made against the stored row.
 */

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

vi.mock('../../services/PostHydrationService', () => ({
  // Passthrough hydration — the response shape is not the subject here, and the
  // linkage is asserted against the database rather than against this value.
  postHydrationService: { hydratePosts: vi.fn(async (records: object[]) => records) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: vi.fn(() => ({ id: '', username: '', name: {}, avatar: null })),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  getServiceOxyClient: () => ({ getUserById: vi.fn(), getUsersByIds: vi.fn(async () => []) }),
  // `undefined` = no membership reader, which is exactly what a caller who names
  // no account gets. These batches name none, so the publish-as gate answers
  // "the caller" without asking Oxy anything.
  createUserScopedOxyServices: vi.fn(() => undefined),
}));

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

// A link preview is a remote fetch and is never allowed to block a create.
vi.mock('../../utils/linkPreviewWarm', () => ({
  warmLinkPreviewForText: vi.fn().mockResolvedValue(undefined),
  warmLinkPreviewForTextDetached: vi.fn(),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readScopePosts, serviceScope } from '../helpers/serviceFixtures';
import { createThread } from '../../controllers/posts/createThread';
import { posts } from '../../db/schema/posts';

const scope = serviceScope('create-thread-chain');
const AUTHOR = scope.user('thread-author');

/**
 * The request the controller actually receives from Express. `query` +
 * `acceptsLanguages` are what the language ladder reads to pick which localized
 * rendition of the created posts to hydrate (`requestLanguageCandidates`); this
 * reader declares none, so hydration serves each post's primary language.
 */
function buildRequest(body: Record<string, unknown>) {
  return {
    user: { id: AUTHOR },
    query: {},
    acceptsLanguages: () => [] as string[],
    headers: {},
    body,
  };
}

function buildResponse() {
  const payload: { value?: { posts: unknown[] }; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: { posts: unknown[] }) {
      payload.value = body;
      return this;
    },
  };
  return { res, payload };
}

/**
 * The stored rows this author owns, in the order the controller created them.
 *
 * Read straight out of `posts` rather than off the response — the response is a
 * hydrated DTO and could carry a link the table does not — but ORDERED by the
 * ids the response reports, because `created_at` is written by `now()` and two
 * inserts a microsecond apart are not a reliable sequence. The id is an
 * identity, not a claim about linkage, so taking it from the response costs the
 * assertions nothing.
 */
async function storedThread(
  payload: { value?: { posts: unknown[] } },
): Promise<Array<typeof posts.$inferSelect>> {
  const rows = await readScopePosts(scope);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = (payload.value?.posts ?? []).map((post) => byId.get((post as { id: string }).id));
  // Every id the controller answered with must name a real row, and there must
  // be no row it did not answer with — a half-written thread is exactly what a
  // per-post failure would leave behind.
  expect(ordered.every((row): row is typeof posts.$inferSelect => row !== undefined)).toBe(true);
  expect(ordered).toHaveLength(rows.length);
  return ordered as Array<typeof posts.$inferSelect>;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('createThread — sequential chain linkage', () => {
  it('chains each continuation post to the immediately-previous post with a shared root threadId', async () => {
    const req = buildRequest({
      mode: 'thread',
      posts: [
        { content: { text: 'Root post' } },
        { content: { text: 'Continuation 1' } },
        { content: { text: 'Continuation 2' } },
      ],
    });

    const { res, payload } = buildResponse();
    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    expect(payload.value?.posts).toHaveLength(3);

    const [root, first, second] = await storedThread(payload);
    expect(root).toBeDefined();

    // Root post: no parent, but it ANCHORS the thread on its own id so the whole
    // self-thread (root included) shares one threadId — this is what lets
    // ThreadSlicingService recognise the root and connect the slice.
    expect(root.parentPostId).toBeNull();
    expect(root.threadId).toBe(root.id);
    // The anchor is a follow-up UPDATE (the id only exists after the insert), so
    // it is the one link in this chain that a failed second write would silently
    // leave null.
    expect(root.isReply).toBe(false);

    // Post 1 chains onto post 0; thread root is post 0.
    expect(first.parentPostId).toBe(root.id);
    expect(first.threadId).toBe(root.id);
    expect(first.isReply).toBe(true);

    // Post 2 chains onto post 1 (NOT post 0 — the fan-out bug); thread root stays post 0.
    expect(second.parentPostId).toBe(first.id);
    expect(second.threadId).toBe(root.id);
    expect(second.isReply).toBe(true);
  });

  it('leaves a single-post thread-mode call unlinked (no threadId on the lone root)', async () => {
    const req = buildRequest({ mode: 'thread', posts: [{ content: { text: 'Solo post' } }] });

    const { res, payload } = buildResponse();
    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    const stored = await storedThread(payload);
    expect(stored).toHaveLength(1);

    // A 1-post "thread" has no continuations to connect, so the root is NOT anchored.
    expect(stored[0].parentPostId).toBeNull();
    expect(stored[0].threadId).toBeNull();
    expect(stored[0].isReply).toBe(false);
  });

  it('does not link beast-mode posts (each post is independent)', async () => {
    const req = buildRequest({
      mode: 'beast',
      posts: [{ content: { text: 'Independent 1' } }, { content: { text: 'Independent 2' } }],
    });

    const { res, payload } = buildResponse();
    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    const stored = await storedThread(payload);
    expect(stored).toHaveLength(2);
    for (const post of stored) {
      expect(post.parentPostId).toBeNull();
      expect(post.threadId).toBeNull();
      expect(post.isReply).toBe(false);
    }
  });

  it('rejects collaborators on a thread without writing anything', async () => {
    // A thread has no single owner/collaborator surface, so the invites are
    // refused up front — and the refusal has to happen BEFORE the first insert,
    // or a rejected request leaves a half-written thread behind.
    const req = buildRequest({
      mode: 'thread',
      posts: [{ content: { text: 'Root' } }, { content: { text: 'Continuation' } }],
      collaboratorIds: [scope.user('invitee')],
    });

    const { res, payload } = buildResponse();
    await createThread(req as never, res as never);

    expect(payload.status).toBe(400);
    expect(await readScopePosts(scope)).toHaveLength(0);
  });
});
