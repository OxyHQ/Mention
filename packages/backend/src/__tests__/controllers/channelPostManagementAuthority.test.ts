/**
 * WHO MAY MANAGE A CHANNEL'S POST — asked of EVERY management route, once each.
 *
 * A channel post carries the channel in `oxy_user_id` and the human who wrote it
 * in `written_by_oxy_user_id`. That second column is written once, at creation,
 * and never revised: not when a colleague rewrites the post, and not when its
 * writer leaves the channel. Every route below used to accept it as authority,
 * off the row alone, with nothing asked of Oxy — so a removed member could go on
 * deleting the channel's queued story, rewriting it under the channel's byline,
 * pinning it, moving it between the channel's lanes and reading its private
 * engagement figures, for as long as they held the post id.
 *
 * `postManagementRefusal` now proves CURRENT membership against Oxy's account
 * graph on every one of them. This suite is the gate's reachability check: the
 * service test beside it (`services/postManagementAccess.test.ts`) pins what the
 * gate answers, and would stay green for a route that never calls it.
 *
 * ## The shape of each case, and why the pair is the point
 *
 * Every route is driven twice over the IDENTICAL fixture, with exactly one thing
 * different: whether Oxy still names the caller as an active member. One field,
 * two outcomes. A single-sided test cannot tell "refuses a departed writer" from
 * "refuses everybody", and refusing everybody is a real failure mode here — a
 * channel authors its own posts, so the free id comparison answers "no" for
 * every human alive.
 *
 * ## The refusal STATUS is part of the contract
 *
 * 404 on the write routes, never 403: the reply for a post the caller may not
 * touch has to be the same as for a post that does not exist, or it becomes an
 * oracle for whether a given post id exists. `GET /statistics/post/:postId`
 * keeps its own 403 — it already answered 404 for a missing post before any of
 * this, so its existence disclosure is unchanged and predates the gate. An Oxy
 * OUTAGE is 503 everywhere: "try again", where a 404 would tell an operator the
 * story they queued had vanished.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const oxy = vi.hoisted(() => ({
  /** Who Oxy says is an ACTIVE member of the channel, right now. */
  activeMembers: [] as string[],
  /** Set to make the account graph unreachable, which must read as 503. */
  outage: false,
  listAccountMembers: vi.fn(),
  claimAndPublishScheduledPost: vi.fn(),
}));

// Oxy is a remote service and stays mocked; every row this suite reads or writes
// is real, including the corrections trail an edit appends.
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => undefined,
  getServiceOxyClient: () => ({
    getUsersByIds: vi.fn(async () => []),
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
  createUserScopedOxyServices: () => ({ listAccountMembers: oxy.listAccountMembers }),
}));

// `resolveUserSummaries` is how `resolveAccountKind` learns that the authoring
// account is a channel — the question `assertCanPublishAsAccount` asks before it
// reads a member list, and the one `updatePost` asks to decide the edit window.
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (rows: object[]) => rows) },
  resolveUserSummaries: vi.fn(async (ids: string[]) => {
    const summaries = new Map();
    for (const id of ids) {
      if (id === CHANNEL) summaries.set(id, { user: { id, username: 'thechannel', kind: 'channel' } });
    }
    return summaries;
  }),
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
  isFallbackUserSummary: (user: { username?: string }) => !user.username,
}));

vi.mock('../../services/PostCollaborationService', () => ({
  postCollaborationService: {
    resolveCollaboratorRefs: vi.fn(async () => []),
    attachCollaborators: vi.fn(),
    autoAcceptInvites: vi.fn(),
    notifyPendingInvites: vi.fn(),
  },
  CollabValidationError: class extends Error {},
  CollabStateError: class extends Error {},
}));

// The publish PIPELINE is the subject of its own suite; what matters here is who
// may start it, so the claim is observed rather than executed.
vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { claimAndPublishScheduledPost: oxy.claimAndPublishScheduledPost },
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(),
  emitTombstone: vi.fn(),
  postRecordUri: () => 'at://test',
}));

vi.mock('../../connectors/outboundFederation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/outboundFederation')>()),
  federateAsResolvedActor: vi.fn(),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { deletePost } from '../../controllers/posts/deletePost';
import { updatePostLane, updatePostSettings } from '../../controllers/posts/postSettings';
import { publishScheduledPostNow } from '../../controllers/posts/scheduledPosts';
import { updatePost } from '../../controllers/posts/updatePost';
import { getPostEditSource } from '../../controllers/postEditSource.controller';
import { getPostInsights } from '../../controllers/statistics.controller';

const scope = serviceScope('channel-post-management-authority');
const CHANNEL = scope.user('channel');
/** The human recorded on the row as having written the post. */
const WRITER = scope.user('writer');

interface Captured {
  status?: number;
  body?: { message?: string };
}

function drive(
  handler: (req: never, res: never) => Promise<unknown>,
  params: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<Captured> {
  const captured: Captured = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: Captured['body']) {
      captured.body = payload;
      return this;
    },
  };
  // `acceptsLanguages` is Express's own, and the edit and publish paths localize
  // their reply through it — a request double without it 500s AFTER the gate has
  // already allowed the call, which reads exactly like a refusal that isn't one.
  const req = {
    user: { id: WRITER },
    params,
    query: {},
    headers: {},
    body,
    acceptsLanguages: () => [] as string[],
  };
  return Promise.resolve(handler(req as never, res as never)).then(() => captured);
}

/** A published channel post, written by WRITER — what six of the seven act on. */
async function seedPublished(): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: CHANNEL,
    authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
    writtenByOxyUserId: WRITER,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'a published story', tag: 'en' }] },
  });
  return record.id;
}

/** The same post, still embargoed — the queue `POST /posts/:id/publish` acts on. */
async function seedScheduled(): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: CHANNEL,
    authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
    writtenByOxyUserId: WRITER,
    status: 'scheduled',
    scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
    content: { variants: [{ source: 'author', text: 'a queued story', tag: 'en' }] },
  });
  return record.id;
}

/**
 * Every route that asks `postManagementRefusal`, named as its client sees it.
 *
 * The list is exhaustive by construction: a route added later that forgets the
 * gate is not caught by this file, which is why the gate has no per-route
 * opt-out to forget in the first place.
 */
const MANAGEMENT_ROUTES: ReadonlyArray<{
  name: string;
  /** What a caller with no current authority must be answered. */
  refusal: number;
  seed: () => Promise<string>;
  run: (postId: string) => Promise<Captured>;
}> = [
  {
    name: 'PUT /posts/:id (edit)',
    refusal: 404,
    seed: seedPublished,
    run: (id) => drive(updatePost, { id }, { text: 'rewritten by somebody who left' }),
  },
  {
    name: 'PATCH /posts/:id/settings',
    refusal: 404,
    seed: seedPublished,
    run: (id) => drive(updatePostSettings, { id }, { isPinned: true }),
  },
  {
    name: 'PATCH /posts/:id/lane',
    refusal: 404,
    seed: seedPublished,
    // `laneId: null` — clearing a lane needs no seeded lane, so the only thing
    // that can produce the refusal is the authorization gate.
    run: (id) => drive(updatePostLane, { id }, { laneId: null }),
  },
  {
    name: 'DELETE /posts/:id',
    refusal: 404,
    seed: seedPublished,
    run: (id) => drive(deletePost, { id }),
  },
  {
    name: 'POST /posts/:id/publish',
    refusal: 404,
    seed: seedScheduled,
    run: (id) => drive(publishScheduledPostNow, { id }),
  },
  {
    name: 'GET /posts/:id/edit-source',
    refusal: 404,
    seed: seedPublished,
    run: (id) => drive(getPostEditSource, { id }),
  },
  {
    name: 'GET /statistics/post/:postId',
    // This route's own status, deliberately kept: it already answered 404 for a
    // post that does not exist before the gate arrived, so a 403 discloses
    // nothing a 404 would not have.
    refusal: 403,
    seed: seedPublished,
    run: (id) => drive(getPostInsights, { postId: id }),
  },
];

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  oxy.activeMembers = [];
  oxy.outage = false;
  oxy.listAccountMembers.mockImplementation(async () => {
    if (oxy.outage) throw new Error('oxy is unreachable');
    return oxy.activeMembers.map((memberUserId) => ({
      _id: `member-${memberUserId}`,
      accountId: CHANNEL,
      memberUserId,
      role: 'editor',
      permissions: ['account:act_as', 'members:read'],
      status: 'active',
    }));
  });
  oxy.claimAndPublishScheduledPost.mockImplementation(async ({ postId }: { postId: string }) => ({
    id: postId,
    status: 'published',
  }));
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe.each(MANAGEMENT_ROUTES)('$name', (route) => {
  it('refuses a writer the channel has removed', async () => {
    // The row still names WRITER — that is the whole defect — and Oxy does not.
    oxy.activeMembers = ['somebody-still-at-the-desk'];

    const response = await route.run(await route.seed());

    expect(response.status).toBe(route.refusal);
    // Asked, rather than assumed to have been asked: a route that skipped the
    // gate and refused for its own reasons would produce the same status.
    expect(oxy.listAccountMembers).toHaveBeenCalledWith(CHANNEL);
  });

  it('allows the same writer while they are still a member', async () => {
    // THE CONTROL, and the reason each case is a pair. Identical fixture,
    // identical request, one field different: the roster. Without it, a gate that
    // refused every human on every channel post would pass the case above — and
    // that is not a hypothetical, it is what dropping the stored-writer clause
    // without putting a membership proof in its place actually does.
    oxy.activeMembers = [WRITER];

    const response = await route.run(await route.seed());

    expect([undefined, 200]).toContain(response.status);
  });

  it('answers 503 when Oxy cannot say, rather than reporting the post gone', async () => {
    oxy.outage = true;

    const response = await route.run(await route.seed());

    expect(response.status).toBe(503);
  });
});

describe('the free path is still free', () => {
  it('asks Oxy nothing when the caller IS the account that authored the post', async () => {
    // The cost claim, asserted rather than described. An ordinary person editing
    // their own post is a string comparison against the row's own owner — nothing
    // about it can go stale, and it must not acquire a round trip.
    const own = await seedPost(scope, {
      oxyUserId: WRITER,
      authorship: [{ oxyUserId: WRITER, role: 'owner', status: 'accepted' }],
      status: 'published',
      content: { variants: [{ source: 'author', text: 'my own post', tag: 'en' }] },
    });

    const response = await drive(updatePostSettings, { id: own.id }, { isPinned: true });

    expect([undefined, 200]).toContain(response.status);
    expect(oxy.listAccountMembers).not.toHaveBeenCalled();
  });
});
