import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 30-minute edit window, and the ONE case it does not apply to.
 *
 * The window exists because readers have already seen a PUBLISHED post, so
 * rewriting one indefinitely is a trust problem. A SCHEDULED post has no
 * readers, so the window would only make a post scheduled for next week
 * uneditable half an hour after it was written.
 *
 * Carving that exception out is exactly the kind of change that quietly widens
 * into "nothing is ever locked", so the published rule is pinned here in both
 * directions — inside the window it saves, outside it 403s — alongside the
 * scheduled carve-out. If a change ever lets a published post be edited a day
 * later, the `published` cases below fail by name.
 *
 * The carve-out is also asserted to be SERVER-decided: the request body cannot
 * select it, and a post that publishes between the read and the write is
 * refused rather than edited.
 */
vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

const hoisted = vi.hoisted(() => ({
  findOne: vi.fn(),
  exists: vi.fn(),
  chainRows: [] as { _id: string; oxyUserId: string; status: string; parentPostId: string | null }[],
  updateMany: vi.fn(),
  hydratePosts: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveUserSummaries: vi.fn(),
  resolveCollaboratorRefs: vi.fn(),
  attachCollaborators: vi.fn(),
  autoAcceptInvites: vi.fn(),
  notifyPendingInvites: vi.fn(),
  emitPostCreated: vi.fn(),
}));

// Only the two model METHODS are stubbed. The module's constants
// (`POST_CLASSIFICATION_PENDING`, read by the re-classification branch) come
// from the real module — a bare object mock silently drops them and every
// saving case 500s inside the handler's own try/catch, which reads exactly like
// the edit having been refused.
vi.mock('../../models/Post', async (importOriginal) => {
  // `loadScheduledChain` reads the rest of the thread; these three answer it from
  // `hoisted.chainRows`, which is empty for every case that is about one post.
  const chainable = (rows: unknown[]) => {
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.sort = () => self;
    self.lean = async () => rows;
    return self;
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    Post: {
      findOne: hoisted.findOne,
      exists: hoisted.exists,
      updateMany: hoisted.updateMany,
      findById: (id: unknown) => ({
        select: () => ({
          lean: async () => hoisted.chainRows.find((row) => row._id === String(id)) ?? null,
        }),
      }),
      find: (filter: Record<string, unknown>) =>
        chainable(
          hoisted.chainRows.filter(
            (row) =>
              row.parentPostId === filter.parentPostId &&
              row.oxyUserId === filter.oxyUserId &&
              row.status === filter.status,
          ),
        ),
    },
  };
});

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

import { updatePost } from '../../controllers/posts.controller';

const USER_ID = 'oxy-author';
const POST_ID = '650000000000000000000010';

const HOUR_MS = 60 * 60 * 1000;

interface PostStub {
  _id: string;
  oxyUserId: string;
  createdAt: Date;
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: Date;
  content: Record<string, unknown>;
  hashtags: string[];
  mentions: string[];
  save: ReturnType<typeof vi.fn>;
  markModified: ReturnType<typeof vi.fn>;
  toObject: () => Record<string, unknown>;
  federation?: null;
  editHistory?: string[];
  isEdited?: boolean;
  visibility?: string;
}

function postStub(overrides: Partial<PostStub> = {}): PostStub {
  const stub: PostStub = {
    _id: POST_ID,
    oxyUserId: USER_ID,
    // Deliberately WELL outside the 30-minute window, so any case that saves
    // does so because of the carve-out and not because it happened to be fresh.
    createdAt: new Date(Date.now() - 26 * HOUR_MS),
    status: 'published',
    content: { variants: [{ tag: 'en', source: 'author', text: 'original' }] },
    hashtags: [],
    mentions: [],
    visibility: 'public',
    federation: null,
    save: vi.fn(async () => undefined),
    markModified: vi.fn(),
    toObject: () => ({ _id: POST_ID }),
    ...overrides,
  };
  return stub;
}

function buildRequest(body: Record<string, unknown>, user: { id: string } | undefined = { id: USER_ID }) {
  return {
    params: { id: POST_ID },
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    body,
    ...(user ? { user } : {}),
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
  hoisted.chainRows = [];
  hoisted.updateMany.mockResolvedValue({ modifiedCount: 0 });
});

describe('updatePost — the 30-minute window still binds a PUBLISHED post', () => {
  it('REFUSES an edit to a published post outside the window', async () => {
    const post = postStub({ status: 'published' });
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'rewritten a day later' } }) as never, res as never);

    expect(captured.status).toBe(403);
    expect(post.save).not.toHaveBeenCalled();
  });

  it('REFUSES an edit to a post with no explicit status (legacy = published)', async () => {
    const post = postStub({ status: undefined });
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'rewritten' } }) as never, res as never);

    expect(captured.status).toBe(403);
    expect(post.save).not.toHaveBeenCalled();
  });

  it('ALLOWS an edit to a published post INSIDE the window (the rule is a window, not a ban)', async () => {
    const post = postStub({ status: 'published', createdAt: new Date(Date.now() - 60_000) });
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'quick fix' } }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(post.save).toHaveBeenCalled();
  });

  it('cannot be talked out of the window by the request body', async () => {
    const post = postStub({ status: 'published' });
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    // A client claiming the post is scheduled must change nothing: the carve-out
    // reads the STORED status.
    await updatePost(
      buildRequest({ content: { text: 'nice try' }, status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS).toISOString() }) as never,
      res as never,
    );

    expect(captured.status).toBe(403);
    expect(post.save).not.toHaveBeenCalled();
  });
});

describe('updatePost — a SCHEDULED post is exempt', () => {
  it('ALLOWS an edit long past the window, because nobody has seen it', async () => {
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + 7 * 24 * HOUR_MS) });
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'still editable next week' } }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(post.save).toHaveBeenCalled();
  });

  it('moves the publish time LATER', async () => {
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS) });
    hoisted.findOne.mockResolvedValue(post);
    const later = new Date(Date.now() + 5 * HOUR_MS);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: later.toISOString() }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(post.scheduledFor?.toISOString()).toBe(later.toISOString());
  });

  it('moves the publish time EARLIER', async () => {
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + 5 * HOUR_MS) });
    hoisted.findOne.mockResolvedValue(post);
    const sooner = new Date(Date.now() + HOUR_MS);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: sooner.toISOString() }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(post.scheduledFor?.toISOString()).toBe(sooner.toISOString());
  });

  it('REFUSES a time in the past', async () => {
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS) });
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    await updatePost(
      buildRequest({ scheduledFor: new Date(Date.now() - 60_000).toISOString() }) as never,
      res as never,
    );

    expect(captured.status).toBe(400);
    expect(post.save).not.toHaveBeenCalled();
  });

  it('REFUSES an unparseable time', async () => {
    const post = postStub({ status: 'scheduled' });
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: 'next tuesday-ish' }) as never, res as never);

    expect(captured.status).toBe(400);
    expect(post.save).not.toHaveBeenCalled();
  });

  it('REFUSES to schedule a post that has already published', async () => {
    const post = postStub({ status: 'published', createdAt: new Date(Date.now() - 60_000) });
    hoisted.findOne.mockResolvedValue(post);
    const { res, captured } = buildResponse();

    await updatePost(
      buildRequest({ scheduledFor: new Date(Date.now() + HOUR_MS).toISOString() }) as never,
      res as never,
    );

    expect(captured.status).toBe(400);
    expect(post.save).not.toHaveBeenCalled();
  });

  it('REFUSES to write when the post published between the read and the save', async () => {
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + 30_000) });
    hoisted.findOne.mockResolvedValue(post);
    // The 60s publisher sweep took it while the edit was being assembled.
    hoisted.exists.mockResolvedValue(null);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'too late' } }) as never, res as never);

    expect(captured.status).toBe(409);
    expect(post.save).not.toHaveBeenCalled();
  });

  it('does not re-read the status for a published edit — that path never used the carve-out', async () => {
    const post = postStub({ status: 'published', createdAt: new Date(Date.now() - 60_000) });
    hoisted.findOne.mockResolvedValue(post);
    const { res } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'quick fix' } }) as never, res as never);

    expect(hoisted.exists).not.toHaveBeenCalled();
    expect(post.save).toHaveBeenCalled();
  });
});

/**
 * A scheduled THREAD has ONE publish moment, not one per post.
 *
 * Its continuations are replies to one another and the author picked a time for
 * the thread, so moving any member moves the chain. Leaving the others behind
 * would not break the ordering invariant — a continuation whose parent is still
 * scheduled simply waits for it — but it would show the author a queue with
 * three different times for one thread and then publish it in dribs.
 */
describe('updatePost — rescheduling moves the whole thread', () => {
  function seedChain() {
    hoisted.chainRows = [
      { _id: POST_ID, oxyUserId: USER_ID, status: 'scheduled', parentPostId: null },
      { _id: 'c1', oxyUserId: USER_ID, status: 'scheduled', parentPostId: POST_ID },
      { _id: 'c2', oxyUserId: USER_ID, status: 'scheduled', parentPostId: 'c1' },
    ];
  }

  it('carries the continuations to the new time', async () => {
    seedChain();
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS) });
    hoisted.findOne.mockResolvedValue(post);
    const later = new Date(Date.now() + 4 * HOUR_MS);
    const { res } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: later.toISOString() }) as never, res as never);

    expect(hoisted.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = hoisted.updateMany.mock.calls[0];
    expect(filter._id.$in).toEqual(['c1', 'c2']);
    expect(update.$set.scheduledFor.toISOString()).toBe(later.toISOString());
  });

  it('scopes the move to the caller\'s own still-scheduled posts', async () => {
    seedChain();
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS) });
    hoisted.findOne.mockResolvedValue(post);
    const { res } = buildResponse();

    await updatePost(
      buildRequest({ scheduledFor: new Date(Date.now() + 2 * HOUR_MS).toISOString() }) as never,
      res as never,
    );

    const [filter] = hoisted.updateMany.mock.calls[0];
    expect(filter.oxyUserId).toBe(USER_ID);
    expect(filter.status).toBe('scheduled');
  });

  it('moves nothing for a lone scheduled post', async () => {
    hoisted.chainRows = [
      { _id: POST_ID, oxyUserId: USER_ID, status: 'scheduled', parentPostId: null },
    ];
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS) });
    hoisted.findOne.mockResolvedValue(post);
    const { res } = buildResponse();

    await updatePost(
      buildRequest({ scheduledFor: new Date(Date.now() + 2 * HOUR_MS).toISOString() }) as never,
      res as never,
    );

    expect(hoisted.updateMany).not.toHaveBeenCalled();
  });

  it('moves nothing when the edit changed no time at all', async () => {
    seedChain();
    const post = postStub({ status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS) });
    hoisted.findOne.mockResolvedValue(post);
    const { res } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'reworded' } }) as never, res as never);

    expect(hoisted.updateMany).not.toHaveBeenCalled();
  });
});
