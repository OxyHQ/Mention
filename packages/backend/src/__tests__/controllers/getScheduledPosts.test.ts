import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getScheduledPosts` — `GET /posts/scheduled`, the feed behind the composer's
 * Unpublished sheet and its preview.
 *
 * Three properties matter and are asserted independently:
 *
 *  1. **The read is scoped to the CALLER.** A scheduled post is deliberately not
 *     public; this predicate is the first of the two server-side gates that keep
 *     it that way (hydration is the second — see `scheduledPostAcl.test.ts`).
 *     Losing `oxy_user_id` here would turn a private listing into everyone's
 *     scheduled posts.
 *  2. **An unauthenticated caller gets 401, not an empty list.** The route sits
 *     on the public router (so `/posts/:id` cannot shadow it), so the handler
 *     self-guards; a silent empty answer would read as "you have none".
 *  3. **It returns HYDRATED posts.** The preview renders through the feed's own
 *     `PostItem`, which needs resolved media/author/poll — raw rows would force
 *     the client to rebuild a slice of hydration and drift from it.
 *
 * The read is REAL. Its predicate used to be asserted as a filter object, which
 * cannot tell a correct scope from one that matches nothing — and "matches
 * nothing" is what a broken scheduled listing looks like from outside. Seeding
 * another user's scheduled post beside the caller's is what makes the scope
 * claim mean something; hydration stays stubbed, because what it returns is the
 * subject of its own suites and here it only has to be observable.
 */
vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

const hoisted = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveUserSummaries: vi.fn(),
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

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import type { PostRecord } from '../../db/posts/postRecord';
import { getScheduledPosts } from '../../controllers/posts.controller';

const scope = serviceScope('get-scheduled-posts');
const VIEWER_ID = scope.user('viewer');
const OTHER_ID = scope.user('someone-else');

/** A future instant, so a seeded scheduled post is never swept as due. */
function later(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function seedScheduled(options: { owner?: string; inMinutes?: number } = {}): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: options.owner ?? VIEWER_ID,
    status: 'scheduled',
    scheduledFor: later(options.inMinutes ?? 60),
  });
  return record.id;
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

/** The ids the handler actually handed to hydration, in order. */
function hydratedIds(): string[] {
  const [records] = hoisted.hydratePosts.mock.calls[0] ?? [];
  return ((records ?? []) as PostRecord[]).map((record) => record.id);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.createScopedOxyClient.mockReturnValue(undefined);
  hoisted.hydratePosts.mockResolvedValue([]);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

describe('getScheduledPosts', () => {
  it("reads ONLY the calling user's scheduled posts, soonest first", async () => {
    const soon = await seedScheduled({ inMinutes: 30 });
    const later = await seedScheduled({ inMinutes: 120 });
    // Neither of these may appear: one belongs to somebody else, one has
    // already published.
    await seedScheduled({ owner: OTHER_ID });
    await seedPost(scope, { oxyUserId: VIEWER_ID });
    const { res } = buildResponse();

    await getScheduledPosts(buildRequest({ user: { id: VIEWER_ID } }) as never, res as never);

    // Soonest first — the order the sheet presents without re-sorting.
    expect(hydratedIds()).toEqual([soon, later]);
  });

  it('hydrates as the caller, so the ACL runs with the right viewer', async () => {
    await seedScheduled();
    const { res } = buildResponse();

    await getScheduledPosts(buildRequest({ user: { id: VIEWER_ID } }) as never, res as never);

    expect(hoisted.hydratePosts).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ viewerId: VIEWER_ID }),
    );
  });

  it('answers with the HYDRATED posts, not the raw rows', async () => {
    const postId = await seedScheduled();
    const hydrated = [{ id: postId, content: { text: 'resolved' } }];
    hoisted.hydratePosts.mockResolvedValue(hydrated);
    const { res, captured } = buildResponse();

    await getScheduledPosts(buildRequest({ user: { id: VIEWER_ID } }) as never, res as never);

    expect(captured.body).toEqual({ posts: hydrated });
  });

  it('refuses an unauthenticated caller with a 401 rather than an empty list', async () => {
    await seedScheduled();
    const { res, captured } = buildResponse();

    await getScheduledPosts(buildRequest() as never, res as never);

    expect(captured.status).toBe(401);
    expect(hoisted.hydratePosts).not.toHaveBeenCalled();
  });

  it('answers 500 without leaking the error when hydration fails', async () => {
    await seedScheduled();
    hoisted.hydratePosts.mockRejectedValue(new Error('the database is down'));
    const { res, captured } = buildResponse();

    await getScheduledPosts(buildRequest({ user: { id: VIEWER_ID } }) as never, res as never);

    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ message: 'Error fetching scheduled posts' });
  });
});
