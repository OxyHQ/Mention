import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN EDIT IS A WRITE BOUNDARY TOO.
 *
 * A profile link the author pastes while EDITING has to become a mention on the
 * same terms as one pasted while composing — otherwise "paste a profile link,
 * get a mention" would be a rule with a hole in it that only shows up on the
 * second save, and the two paths would drift the moment either is touched.
 *
 * These pin the edit half at the real controller: the resolved id lands in the
 * post's stored `mentions`, the body it saves carries the placeholder, and the
 * `content` subtree is marked modified — without which Mongoose writes the
 * mention allowlist and silently drops the body rewrite it depends on, leaving a
 * stored id with no placeholder behind it (which hydration renders as nothing).
 *
 * Harness mirrors `controllers/updatePostScheduledWindow.test.ts`.
 */
vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

const hoisted = vi.hoisted(() => ({
  findOne: vi.fn(),
  exists: vi.fn(),
  updateMany: vi.fn(),
  hydratePosts: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveUserSummaries: vi.fn(),
  resolveCollaboratorRefs: vi.fn(),
  attachCollaborators: vi.fn(),
  autoAcceptInvites: vi.fn(),
  notifyPendingInvites: vi.fn(),
  emitPostCreated: vi.fn(),
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
  findExistingActor: vi.fn(),
}));

vi.mock('../../models/Post', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Post: {
    findOne: hoisted.findOne,
    exists: hoisted.exists,
    updateMany: hoisted.updateMany,
    findById: () => ({ select: () => ({ lean: async () => null }) }),
    find: () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }),
  },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: hoisted.resolveUserSummaries,
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

vi.mock('../../services/postCollaborationService', () => ({
  postCollaborationService: {
    resolveCollaboratorRefs: hoisted.resolveCollaboratorRefs,
    attachCollaborators: hoisted.attachCollaborators,
    autoAcceptInvites: hoisted.autoAcceptInvites,
    notifyPendingInvites: hoisted.notifyPendingInvites,
  },
}));

vi.mock('../../services/mtn/postRecords', () => ({
  emitPostCreated: hoisted.emitPostCreated,
  emitTombstone: vi.fn(),
  postRecordUri: () => 'at://test',
}));

// PARTIAL: `posts.controller` pulls the whole connector graph in, and
// `actor.service` reads `FEDERATION_ENABLED` from this module at import time — a
// bare object mock drops it and the suite fails to load rather than to assert.
vi.mock('../../connectors/activitypub/constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBlockedDomain: hoisted.isBlockedDomain,
  resolveOxyUser: hoisted.resolveOxyUser,
}));

vi.mock('../../models/FederatedActor', () => ({
  default: { findOne: hoisted.findExistingActor },
}));

import { updatePost } from '../../controllers/posts.controller';

const OWN_HOST = 'mention.earth';
const USER_ID = 'oxy-author';
const POST_ID = '650000000000000000000010';
const ALICE_OXY_ID = 'oxy_alice_local';

interface PostStub {
  _id: string;
  oxyUserId: string;
  createdAt: Date;
  status: 'published';
  content: { variants: Array<{ tag: string; source: string; text: string }> };
  hashtags: string[];
  mentions: string[];
  visibility: string;
  federation: null;
  save: ReturnType<typeof vi.fn>;
  markModified: ReturnType<typeof vi.fn>;
  toObject: () => Record<string, unknown>;
}

/** A freshly published post, well inside the 30-minute edit window. */
function postStub(text: string, mentions: string[] = []): PostStub {
  return {
    _id: POST_ID,
    oxyUserId: USER_ID,
    createdAt: new Date(Date.now() - 60_000),
    status: 'published',
    content: { variants: [{ tag: 'en', source: 'author', text }] },
    hashtags: [],
    mentions,
    visibility: 'public',
    federation: null,
    save: vi.fn(async () => undefined),
    markModified: vi.fn(),
    toObject: () => ({ _id: POST_ID }),
  };
}

function buildRequest(body: Record<string, unknown>) {
  return {
    params: { id: POST_ID },
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    body,
    user: { id: USER_ID },
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
  hoisted.hydratePosts.mockResolvedValue([{ id: POST_ID }]);
  hoisted.resolveCollaboratorRefs.mockResolvedValue(undefined);
  hoisted.exists.mockResolvedValue({ _id: POST_ID });
  hoisted.updateMany.mockResolvedValue({ modifiedCount: 0 });
  hoisted.isBlockedDomain.mockImplementation(
    (host: string) => host.toLowerCase().replace(/^www\./, '') === OWN_HOST,
  );
  hoisted.resolveOxyUser.mockImplementation(async (username: string) =>
    username === 'alice' ? { _id: ALICE_OXY_ID } : null,
  );
  hoisted.findExistingActor.mockReturnValue({ lean: async () => null });
});

describe('updatePost — a profile link pasted while editing becomes a mention', () => {
  it('stores the id, rewrites the saved body, and marks `content` modified', async () => {
    const post = postStub('nothing here yet');
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    await updatePost(
      buildRequest({ content: { text: `now ask https://${OWN_HOST}/@alice` } }) as never,
      res as never,
    );

    expect(captured.status).toBeUndefined();
    expect(post.content.variants[0].text).toBe(`now ask [mention:${ALICE_OXY_ID}]`);
    expect(post.mentions).toEqual([ALICE_OXY_ID]);
    expect(post.markModified).toHaveBeenCalledWith('content');
    expect(post.save).toHaveBeenCalled();
  });

  it('leaves a link it cannot resolve alone, and mentions nobody', async () => {
    const post = postStub('nothing here yet');
    hoisted.findOne.mockResolvedValue(post);
    const { res } = buildResponse();

    await updatePost(
      buildRequest({ content: { text: 'see https://mastodon.social/@a-stranger' } }) as never,
      res as never,
    );

    expect(post.content.variants[0].text).toBe('see https://mastodon.social/@a-stranger');
    expect(post.mentions).toEqual([]);
    expect(post.markModified).not.toHaveBeenCalledWith('content');
  });

  it('drops a mention whose link the author REMOVED in the same edit', async () => {
    // The id was authorized by the previous save; the body no longer names her,
    // so reconciliation — which intersects the allowlist with the placeholders
    // actually present — must not carry it forward.
    const post = postStub(`bye [mention:${ALICE_OXY_ID}]`, [ALICE_OXY_ID]);
    hoisted.findOne.mockResolvedValue(post);
    const { res } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'never mind' } }) as never, res as never);

    expect(post.mentions).toEqual([]);
  });
});
