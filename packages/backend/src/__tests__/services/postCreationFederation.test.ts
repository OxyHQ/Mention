import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the immediate-create federation fan-out
 * ({@link PostCreationService.runPostSideEffects}).
 *
 * Root cause this guards: the Oxy auth middleware guards every `POST /posts` path
 * WITHOUT `loadUser:true`, so `req.user` is only `{ id }` and the caller-supplied
 * `senderUsername` is effectively ALWAYS undefined on the immediate create path.
 * The federation gate used to require `ctx.senderUsername`, so `federateNewPost`
 * NEVER ran and `metadata.federationDelivered` was true on ZERO posts.
 *
 * The fix resolves the federation username server-side from the authoritative
 * `oxyUserId` (via the service Oxy client) whenever no non-empty username was
 * supplied — the SAME mechanism the scheduled-publish path already used.
 *
 * ## What changed with the Postgres port
 *
 * `federationDelivered` is the IDEMPOTENCY MARKER: it is what stops a post
 * fanning out twice, and it is only worth anything if it is durable. The old
 * suite read it off the in-memory object the service returned, which would pass
 * just as happily if the flag were set on a detached copy and never written —
 * exactly the bug that would federate every post again on the next code path
 * that touches it. `metadata.federation_delivered` is a real column now, so each
 * test reloads the row and asserts the STORED value.
 *
 * The federator and the Oxy client stay mocked: they are the two network
 * boundaries, and which of them was called with what IS the subject here.
 */

const { federateNewPost, getUserById } = vi.hoisted(() => ({
  federateNewPost: vi.fn().mockResolvedValue(undefined),
  getUserById: vi.fn(),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost }),
  registerPostCreator: vi.fn(),
}));

// Mocked to a no-op so importing PostCreationService does not pull in the heavy
// `../../server` module graph via the socket-emit hydration path.
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUserById, getUsersByIds: vi.fn().mockResolvedValue([]) }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearServiceScope,
  readPost,
  readScopePosts,
  serviceScope,
  trackPost,
  withDeadlockRetry,
} from '../helpers/serviceFixtures';
import { postCreationService } from '../../services/PostCreationService';
import { PostVisibility } from '@mention/shared-types';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = serviceScope('post-creation-federation');
const AUTHOR = scope.user('fed-author');

async function createAndReload(
  params: Parameters<typeof postCreationService.create>[0],
): Promise<PostRecord> {
  // Retried on `40P01` only: ten suites write `posts` concurrently and its four
  // self-referencing foreign keys make bulk statements contend for locks in
  // different orders. See `withDeadlockRetry`.
  const created = await withDeadlockRetry(() => postCreationService.create(params));
  trackPost(scope, created.id);
  const stored = await readPost(created.id);
  if (!stored) throw new Error(`post ${created.id} was not readable after create`);
  return stored;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  getUserById.mockResolvedValue({ id: AUTHOR, username: 'resolved_alice' });
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('PostCreationService — immediate-create federation username sourcing', () => {
  it('federates a published public post with NO senderUsername using the server-resolved username', async () => {
    const post = await createAndReload({
      oxyUserId: AUTHOR,
      content: { text: 'a public post that should reach remote followers' },
      visibility: PostVisibility.PUBLIC,
      // Simulate the real request: req.user is only { id } (no username), so the
      // controller passes senderUsername: undefined.
      senderUsername: undefined,
      skipSocketEmit: true,
    });

    // The username was resolved server-side from the authoritative oxyUserId.
    expect(getUserById).toHaveBeenCalledWith(AUTHOR);

    // The fan-out ran with that resolved username, for the post that was stored.
    expect(federateNewPost).toHaveBeenCalledTimes(1);
    const [federatedPost, calledOxyId, calledUsername] = federateNewPost.mock.calls[0];
    expect((federatedPost as { id: string }).id).toBe(post.id);
    expect(calledOxyId).toBe(AUTHOR);
    expect(calledUsername).toBe('resolved_alice');

    // The idempotency marker is DURABLE — it is the only thing standing between
    // this post and a second fan-out, so an in-memory-only flag is worthless.
    expect(post.metadata.federationDelivered).toBe(true);
  });

  it('prefers a supplied non-empty senderUsername (fast path, no SDK lookup)', async () => {
    const post = await createAndReload({
      oxyUserId: AUTHOR,
      content: { text: 'a post created with an explicit sender username' },
      visibility: PostVisibility.PUBLIC,
      senderUsername: 'provided_bob',
      skipSocketEmit: true,
    });

    // The provided username short-circuits the server-side lookup.
    expect(getUserById).not.toHaveBeenCalled();
    expect(federateNewPost).toHaveBeenCalledTimes(1);
    expect(federateNewPost.mock.calls[0][2]).toBe('provided_bob');
    expect(post.metadata.federationDelivered).toBe(true);
  });

  it('does NOT federate when the server-side username cannot be resolved', async () => {
    getUserById.mockResolvedValue({ id: AUTHOR, username: undefined });

    const post = await createAndReload({
      oxyUserId: AUTHOR,
      content: { text: 'a post whose author has no resolvable username' },
      visibility: PostVisibility.PUBLIC,
      senderUsername: undefined,
      skipSocketEmit: true,
    });

    expect(getUserById).toHaveBeenCalledWith(AUTHOR);
    expect(federateNewPost).not.toHaveBeenCalled();
    // Crucially the marker is still FALSE: an unfederated post that looks
    // delivered can never be retried by any later path. (The column is
    // `NOT NULL DEFAULT false`, so "unstamped" reads as `false` here, not as
    // the `undefined` a Mongo document would have shown.)
    expect(post.metadata.federationDelivered).toBe(false);
  });

  it('leaves the marker unstamped — and the fan-out unrun — for a scheduled post', async () => {
    // A scheduled post is not published yet, so nothing may go out and nothing
    // may claim it did. `ScheduledPostPublisher` federates it later, and it can
    // only do that if the marker is still absent.
    const post = await createAndReload({
      oxyUserId: AUTHOR,
      content: { text: 'a post that goes live later' },
      visibility: PostVisibility.PUBLIC,
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 3_600_000),
      skipSocketEmit: true,
    });

    expect(federateNewPost).not.toHaveBeenCalled();
    expect(post.status).toBe('scheduled');
    expect(post.metadata.federationDelivered).toBe(false);
  });

  it('still REFUSES a blank federated Note that carries no boostOf', async () => {
    // The other half of the boost exemption, and the reason it is written as
    // `federation != null && boostOf == null` rather than dropped outright. A
    // boost renders from `boostOf`; a Note with no body, no media, no
    // attachment, no poll and no content warning renders NOTHING, and storing it
    // is storing a ghost. Widening the exemption to every federated post is the
    // obvious over-correction, and this is what catches it.
    await expect(
      postCreationService.create({
        oxyUserId: AUTHOR,
        content: { text: '   ' },
        visibility: PostVisibility.PUBLIC,
        federation: { activityId: `https://${scope.name}.test/statuses/blank` },
        skipSocketEmit: true,
      }),
    ).rejects.toThrow(/refusing to create empty federated post/);

    // And nothing was written on the way to the throw.
    expect(await readScopePosts(scope)).toHaveLength(0);
  });

  it('accepts a blank federated Note that carries a content warning', async () => {
    // The guard's own escape hatch, and the control that keeps the case above
    // from passing on a creator that refuses everything: a spoiler-only post has
    // something to render.
    const post = await createAndReload({
      oxyUserId: AUTHOR,
      content: { text: '' },
      visibility: PostVisibility.PUBLIC,
      federation: {
        activityId: `https://${scope.name}.test/statuses/cw-only`,
        spoilerText: 'content warning only',
      },
      skipSocketEmit: true,
    });

    expect(post.federation?.spoilerText).toBe('content warning only');
  });

  it('defers the fan-out for a post carrying a pending collaborator invite', async () => {
    // An invitee must never be leaked to the fediverse before consenting, so the
    // deferral flag is written at INSERT — a post that federated between two
    // writes could not be un-federated.
    const post = await createAndReload({
      oxyUserId: AUTHOR,
      content: { text: 'a collaborative post awaiting consent' },
      visibility: PostVisibility.PUBLIC,
      collaboratorIds: [scope.user('invitee')],
      skipSocketEmit: true,
    });

    expect(federateNewPost).not.toHaveBeenCalled();
    expect(post.metadata.collabFederationDeferred).toBe(true);
    expect(post.metadata.federationDelivered).toBe(false);
    // The invite is a stored authorship row, which is what `accept()` later reads
    // to decide the post may finally fan out.
    expect(post.authorship).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oxyUserId: scope.user('invitee'), status: 'pending' }),
      ]),
    );
  });
});
