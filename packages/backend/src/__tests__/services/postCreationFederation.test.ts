import { describe, it, expect, vi, beforeEach } from 'vitest';

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
 * supplied — the SAME mechanism the scheduled-publish path already used. These
 * tests assert:
 *   1. a published local public post with NO senderUsername STILL federates,
 *      using the server-resolved username, and marks federationDelivered;
 *   2. a supplied non-empty senderUsername is preferred as a fast path (no SDK
 *      lookup) — preserving existing callers/tests.
 *
 * Test (1) FAILS against the pre-fix gate (federateNewPost is never called) and
 * PASSES after it.
 *
 * The Post model + every side-effect collaborator are mocked so the test isolates
 * the federation-username sourcing and gate. The classifier is pure and left real.
 */

const { federateNewPost, getUserById, MockPost, postFindLean } = vi.hoisted(() => {
  class HoistedMockPost {
    [key: string]: unknown;
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
    }
    save = vi.fn().mockResolvedValue(undefined);
    markModified = vi.fn();
    toObject(): Record<string, unknown> {
      return { ...this };
    }
    _id = 'mock_post_id';
  }
  return {
    federateNewPost: vi.fn().mockResolvedValue(undefined),
    getUserById: vi.fn(),
    MockPost: HoistedMockPost,
    postFindLean: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../models/Post', async () => {
  const actual = await vi.importActual<typeof import('../../models/Post')>('../../models/Post');
  return {
    POST_CLASSIFICATION_PENDING: actual.POST_CLASSIFICATION_PENDING,
    Post: Object.assign(MockPost, {
      find: () => ({ select: () => ({ lean: () => postFindLean() }) }),
    }),
  };
});

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/PostSubscription', () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
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

import { postCreationService } from '../../services/PostCreationService';
import { PostVisibility } from '@mention/shared-types';

beforeEach(() => {
  vi.clearAllMocks();
  getUserById.mockResolvedValue({ id: 'oxy_user_fed', username: 'resolved_alice' });
  postFindLean.mockResolvedValue([]);
});

describe('PostCreationService — immediate-create federation username sourcing', () => {
  it('federates a published public post with NO senderUsername using the server-resolved username', async () => {
    const post = await postCreationService.create({
      oxyUserId: 'oxy_user_fed',
      content: { text: 'a public post that should reach remote followers' },
      visibility: PostVisibility.PUBLIC,
      // Simulate the real request: req.user is only { id } (no username), so the
      // controller passes senderUsername: undefined.
      senderUsername: undefined,
      skipSocketEmit: true,
    });

    // The username was resolved server-side from the authoritative oxyUserId.
    expect(getUserById).toHaveBeenCalledWith('oxy_user_fed');

    // The fan-out ran with that resolved username.
    expect(federateNewPost).toHaveBeenCalledTimes(1);
    const [, calledOxyId, calledUsername] = federateNewPost.mock.calls[0];
    expect(calledOxyId).toBe('oxy_user_fed');
    expect(calledUsername).toBe('resolved_alice');

    // Idempotency marker is set so the post never re-federates.
    const meta = (post as unknown as { metadata?: Record<string, unknown> }).metadata;
    expect(meta?.federationDelivered).toBe(true);
  });

  it('prefers a supplied non-empty senderUsername (fast path, no SDK lookup)', async () => {
    await postCreationService.create({
      oxyUserId: 'oxy_user_fed',
      content: { text: 'a post created with an explicit sender username' },
      visibility: PostVisibility.PUBLIC,
      senderUsername: 'provided_bob',
      skipSocketEmit: true,
    });

    // The provided username short-circuits the server-side lookup.
    expect(getUserById).not.toHaveBeenCalled();
    expect(federateNewPost).toHaveBeenCalledTimes(1);
    const [, , calledUsername] = federateNewPost.mock.calls[0];
    expect(calledUsername).toBe('provided_bob');
  });

  it('does NOT federate when the server-side username cannot be resolved', async () => {
    getUserById.mockResolvedValue({ id: 'oxy_user_fed', username: undefined });

    const post = await postCreationService.create({
      oxyUserId: 'oxy_user_fed',
      content: { text: 'a post whose author has no resolvable username' },
      visibility: PostVisibility.PUBLIC,
      senderUsername: undefined,
      skipSocketEmit: true,
    });

    expect(getUserById).toHaveBeenCalledWith('oxy_user_fed');
    expect(federateNewPost).not.toHaveBeenCalled();
    const meta = (post as unknown as { metadata?: Record<string, unknown> }).metadata;
    expect(meta?.federationDelivered).toBeUndefined();
  });
});
