import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link getScheduledPosts} — `GET /posts/scheduled`, the feed
 * behind the composer's Unpublished sheet and its preview.
 *
 * Three properties matter and are asserted independently:
 *
 *  1. **The query is scoped to the CALLER.** A scheduled post is deliberately
 *     not public; this filter is the first of the two server-side gates that
 *     keep it that way (hydration is the second — see
 *     `scheduledPostAcl.test.ts`). Losing `oxyUserId` here would turn a private
 *     listing into everyone's scheduled posts.
 *  2. **An unauthenticated caller gets 401, not an empty list.** The route sits
 *     on the public router (so `/posts/:id` cannot shadow it), so the handler
 *     self-guards; a silent empty answer would read as "you have none".
 *  3. **It returns HYDRATED posts.** The preview renders through the feed's own
 *     `PostItem`, which needs resolved media/author/poll — raw lean documents
 *     would force the client to rebuild a slice of hydration and drift from it.
 */
vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

const hoisted = vi.hoisted(() => ({
  find: vi.fn(),
  hydratePosts: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveUserSummaries: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  Post: { find: hoisted.find },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: hoisted.resolveUserSummaries,
  degradedActorSummary: (id: string) => ({
    id,
    username: '',
    name: { displayName: 'Unknown user' },
  }),
}));

import { getScheduledPosts } from '../../controllers/posts.controller';

const VIEWER_ID = 'oxy-viewer';

/** Chainable `Post.find(...).sort(...).lean()` stub. */
function stubFind(rows: unknown[]) {
  const sort = vi.fn(() => ({ lean: async () => rows }));
  hoisted.find.mockReturnValue({ sort });
  return { sort };
}

function buildRequest(overrides: Record<string, unknown> = {}) {
  // `acceptsLanguages` is Express's, and `requestLanguageCandidates` calls it on
  // the way into hydration — omitting it throws inside the handler's try/catch
  // and turns every assertion below into a silent 500.
  return {
    params: {},
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    ...overrides,
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

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.createScopedOxyClient.mockReturnValue(undefined);
  hoisted.hydratePosts.mockResolvedValue([]);
});

describe('getScheduledPosts', () => {
  it('reads ONLY the calling user\'s scheduled posts', async () => {
    const { sort } = stubFind([{ _id: 'post-1' }]);
    const { res } = buildResponse();

    await getScheduledPosts(buildRequest({ user: { id: VIEWER_ID } }) as never, res as never);

    expect(hoisted.find).toHaveBeenCalledWith({
      oxyUserId: VIEWER_ID,
      status: 'scheduled',
    });
    // Soonest first — the order the sheet presents without re-sorting.
    expect(sort).toHaveBeenCalledWith({ scheduledFor: 1 });
  });

  it('hydrates as the caller, so the ACL runs with the right viewer', async () => {
    stubFind([{ _id: 'post-1' }]);
    const { res } = buildResponse();

    await getScheduledPosts(buildRequest({ user: { id: VIEWER_ID } }) as never, res as never);

    expect(hoisted.hydratePosts).toHaveBeenCalledWith(
      [{ _id: 'post-1' }],
      expect.objectContaining({ viewerId: VIEWER_ID }),
    );
  });

  it('answers with the HYDRATED posts, not the raw documents', async () => {
    stubFind([{ _id: 'post-1', content: { variants: [{ text: 'raw' }] } }]);
    const hydrated = [{ id: 'post-1', content: { text: 'resolved' } }];
    hoisted.hydratePosts.mockResolvedValue(hydrated);
    const { res, captured } = buildResponse();

    await getScheduledPosts(buildRequest({ user: { id: VIEWER_ID } }) as never, res as never);

    expect(captured.body).toEqual({ posts: hydrated });
  });

  it('refuses an unauthenticated caller with a 401 rather than an empty list', async () => {
    const { res, captured } = buildResponse();

    await getScheduledPosts(buildRequest() as never, res as never);

    expect(captured.status).toBe(401);
    expect(hoisted.find).not.toHaveBeenCalled();
    expect(hoisted.hydratePosts).not.toHaveBeenCalled();
  });

  it('answers 500 without leaking the error when the read fails', async () => {
    hoisted.find.mockImplementation(() => {
      throw new Error('mongo is down');
    });
    const { res, captured } = buildResponse();

    await getScheduledPosts(buildRequest({ user: { id: VIEWER_ID } }) as never, res as never);

    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ message: 'Error fetching scheduled posts' });
  });
});
