import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two routes behind the composer's "Saved to your account" drafts:
 * `GET /posts/drafts` and `POST /posts/:id/publish` on a draft.
 *
 * The list used to answer with RAW ROWS — the stored shape, variants and all,
 * with no author and no display URLs — so the app could not preview one through
 * the feed's renderer, and the MCP `get-drafts` tool, which reads `posts` off
 * the response, found nothing at all. It is asserted here to answer with
 * hydrated `{ posts }` for the caller only, newest first.
 *
 * The publish is driven through the real controller and the real claim, against
 * real rows; only `publishScheduledPost` — the pipeline behind the claim, covered
 * in `services/publishServerDraft.test.ts` — is stubbed, so how OFTEN it runs is
 * what shows.
 */

const hoisted = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  listAccounts: vi.fn(),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => undefined),
  // The reader `listOperatedChannelIds` is asked with. No channels by default,
  // so the read collapses to the caller's own drafts; the channel half is the
  // same predicate `channelEditorialQueue.test.ts` drives for the scheduled list.
  createUserScopedOxyServices: () => ({
    listAccounts: async () => hoisted.listAccounts(),
    listAccountMembers: async () => [],
  }),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  // Resolves no account kinds, so a stranger's post reads as an account nothing
  // can be published as — the refusal `postManagementRefusal` answers 404 to.
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import type { PostRecord } from '../../db/posts/postRecord';
import { getDrafts, publishScheduledPostNow } from '../../controllers/posts/scheduledPosts';
import { postCreationService } from '../../services/PostCreationService';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';

const scope = serviceScope('server-drafts');
const VIEWER = scope.user('viewer');
const STRANGER = scope.user('stranger');

const publishSpy = vi.spyOn(postCreationService, 'publishScheduledPost');

async function seedDraft(owner: string = VIEWER, createdAt?: Date): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: owner,
    status: 'draft',
    ...(createdAt ? { createdAt } : {}),
  });
  return record.id;
}

function buildRequest(userId: string | undefined, params: Record<string, string> = {}) {
  // `acceptsLanguages` is Express's, and `requestLanguageCandidates` calls it on
  // the way into hydration — omitting it throws inside the handler's try/catch
  // and turns every assertion below into a silent 500.
  return {
    user: userId ? { id: userId } : undefined,
    params,
    query: {},
    body: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
  };
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

/** The ids the handler handed to hydration, in order. */
function hydratedIds(): string[] {
  const [records] = hoisted.hydratePosts.mock.calls[0] ?? [];
  return ((records ?? []) as PostRecord[]).map((record) => record.id);
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.listAccounts.mockResolvedValue([]);
  hoisted.hydratePosts.mockImplementation(async (posts: PostRecord[]) =>
    posts.map((post) => ({ id: post.id })));
  publishSpy.mockImplementation(async (post: PostRecord) => post);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  publishSpy.mockRestore();
  await closePostgres();
});

describe('GET /posts/drafts', () => {
  it("reads ONLY the caller's drafts, newest first", async () => {
    const older = await seedDraft(VIEWER, new Date('2026-09-01T09:00:00.000Z'));
    const newer = await seedDraft(VIEWER, new Date('2026-09-02T09:00:00.000Z'));
    // None of these may appear: somebody else's draft, and the caller's own
    // scheduled and published posts.
    await seedDraft(STRANGER);
    await seedPost(scope, { oxyUserId: VIEWER, status: 'scheduled', scheduledFor: new Date(Date.now() + 3_600_000) });
    await seedPost(scope, { oxyUserId: VIEWER });
    const { res } = buildResponse();

    await getDrafts(buildRequest(VIEWER) as never, res as never);

    expect(hydratedIds()).toEqual([newer, older]);
  });

  it('answers with the HYDRATED posts, hydrated as the caller', async () => {
    const postId = await seedDraft();
    const hydrated = [{ id: postId, content: { text: 'resolved' } }];
    hoisted.hydratePosts.mockResolvedValue(hydrated);
    const { res, captured } = buildResponse();

    await getDrafts(buildRequest(VIEWER) as never, res as never);

    expect(captured.body).toEqual({ posts: hydrated });
    expect(hoisted.hydratePosts).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ viewerId: VIEWER, includeCommunityNotes: false }),
    );
  });

  it('refuses an unauthenticated caller with a 401 rather than an empty list', async () => {
    await seedDraft();
    const { res, captured } = buildResponse();

    await getDrafts(buildRequest(undefined) as never, res as never);

    expect(captured.status).toBe(401);
    expect(hoisted.hydratePosts).not.toHaveBeenCalled();
  });
});

describe('POST /posts/:id/publish on a draft', () => {
  it('publishes the draft once, through the scheduled pipeline, and answers with it', async () => {
    const postId = await seedDraft();
    const { res, captured } = buildResponse();

    await publishScheduledPostNow(buildRequest(VIEWER, { id: postId }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(captured.body).toEqual({ id: postId });
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect((await readPost(postId))?.status).toBe('published');
  });

  it('answers 409 to a second publish, and does not run the pipeline again', async () => {
    const postId = await seedDraft();
    await publishScheduledPostNow(buildRequest(VIEWER, { id: postId }) as never, buildResponse().res as never);
    const { res, captured } = buildResponse();

    await publishScheduledPostNow(buildRequest(VIEWER, { id: postId }) as never, res as never);

    expect(captured.status).toBe(409);
    expect(captured.body).toEqual({ message: 'This post has already been published' });
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses somebody else's draft as not found, and leaves it a draft", async () => {
    const postId = await seedDraft(STRANGER);
    const { res, captured } = buildResponse();

    await publishScheduledPostNow(buildRequest(VIEWER, { id: postId }) as never, res as never);

    expect(captured.status).toBe(404);
    expect(publishSpy).not.toHaveBeenCalled();
    expect((await readPost(postId))?.status).toBe('draft');
  });
});
