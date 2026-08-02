import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Scheduling a batch, in either composer mode.
 *
 * Beast posts are independent — nothing chains to anything — so scheduling them
 * is n independent scheduled posts, each published on its own by the 60s sweep.
 * A THREAD is a chain: every continuation is created with its predecessor as
 * `parentPostId`. That difference is real, but it is NOT this controller's to
 * resolve — the publish path owns it (`claimAndPublishScheduledPost` refuses a
 * post whose parent has not published; `ScheduledPostPublisher` walks the chain
 * parent-first), which is why both modes schedule here on identical terms and
 * with one shared time.
 *
 * The second half is about what must NOT happen at schedule time. A scheduled
 * post is not readable yet, so anything that tells a READER about it — the
 * real-time feed emit, mention notifications — has to wait for the publish, or
 * it points people at a post the ACL will refuse them.
 */
const hoisted = vi.hoisted(() => ({
  emit: vi.fn(),
  createMentionNotifications: vi.fn(async () => undefined),
  create: vi.fn(),
}));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => ({ emit: hoisted.emit }),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../utils/notificationUtils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMentionNotifications: hoisted.createMentionNotifications,
}));

import { Post } from '../../models/Post';

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    create: hoisted.create.mockImplementation(async (params: Record<string, unknown>) => {
      const post = new Post({
        oxyUserId: params.oxyUserId,
        content: params.content,
        mentions: params.mentions,
        visibility: params.visibility,
        ...(params.status ? { status: params.status } : {}),
        ...(params.scheduledFor ? { scheduledFor: params.scheduledFor } : {}),
      });
      return post;
    }),
  },
}));

import { createThread } from '../../controllers/posts.controller';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function buildRequest(body: Record<string, unknown>) {
  return {
    user: { id: 'author_1' },
    query: {},
    acceptsLanguages: () => [] as string[],
    headers: {},
    body,
  };
}

function buildResponse() {
  const payload: { value?: { posts?: unknown[]; message?: string }; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: { posts?: unknown[]; message?: string }) {
      payload.value = body;
      return this;
    },
  };
  return { res, payload };
}

function beastBody(extra: Record<string, unknown> = {}) {
  return {
    mode: 'beast',
    posts: [{ content: { text: 'One' } }, { content: { text: 'Two' } }],
    ...extra,
  };
}

/** The `status`/`scheduledFor` every post of the batch was created with. */
function creationSchedules() {
  return hoisted.create.mock.calls.map(([params]: [Record<string, unknown>]) => ({
    status: params.status,
    scheduledFor: params.scheduledFor,
  }));
}

describe('createThread — scheduling a beast batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Post.prototype, 'save').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules EVERY post of a beast batch, at the one time the author picked', async () => {
    const { res, payload } = buildResponse();
    await createThread(buildRequest(beastBody({ scheduledFor: FUTURE })) as never, res as never);

    expect(payload.status).toBe(201);
    expect(payload.value?.posts).toHaveLength(2);
    // One time for the set, not n times: the author picked a moment for the
    // batch, and a post silently created as `published` would go out now.
    expect(creationSchedules()).toEqual([
      { status: 'scheduled', scheduledFor: new Date(FUTURE) },
      { status: 'scheduled', scheduledFor: new Date(FUTURE) },
    ]);
  });

  /**
   * A scheduled THREAD is created exactly like an immediate one — the chain is
   * built here (each continuation carries its predecessor as `parentPostId`) and
   * the ordering of the eventual publication is the publish path's problem. One
   * shared time is what lets the sweep pick the whole chain up on one tick.
   */
  it('schedules a THREAD too, chained and at one shared time', async () => {
    const { res, payload } = buildResponse();
    await createThread(
      buildRequest({
        mode: 'thread',
        posts: [{ content: { text: 'Root' } }, { content: { text: 'Continuation' } }],
        scheduledFor: FUTURE,
      }) as never,
      res as never,
    );

    expect(payload.status).toBe(201);
    expect(creationSchedules()).toEqual([
      { status: 'scheduled', scheduledFor: new Date(FUTURE) },
      { status: 'scheduled', scheduledFor: new Date(FUTURE) },
    ]);
    // The chain survives scheduling: the continuation still replies to the root,
    // which is exactly what the publisher orders by.
    const [, continuation] = hoisted.create.mock.calls.map(
      ([params]: [Record<string, unknown>]) => params,
    );
    expect(continuation.parentPostId).toBeTruthy();
  });

  it('publishes a beast batch immediately when no time was picked', async () => {
    const { res, payload } = buildResponse();
    await createThread(buildRequest(beastBody()) as never, res as never);

    expect(payload.status).toBe(201);
    // Absent, not `'published'` — `create()` defaults, and asserting the default
    // here would pin the wrong file.
    expect(creationSchedules()).toEqual([
      { status: undefined, scheduledFor: undefined },
      { status: undefined, scheduledFor: undefined },
    ]);
  });

  it('applies the SAME date checks a single scheduled post gets', async () => {
    for (const [body, message] of [
      [beastBody({ scheduledFor: PAST }), 'Scheduled time must be in the future'],
      [beastBody({ scheduledFor: 'not a date' }), 'Invalid scheduled time'],
      [beastBody({ status: 'scheduled' }), 'scheduledFor is required when scheduling a post'],
    ] as const) {
      hoisted.create.mockClear();
      const { res, payload } = buildResponse();
      await createThread(buildRequest(body) as never, res as never);

      expect(payload.status).toBe(400);
      expect(payload.value?.message).toBe(message);
      // A refused batch must create nothing — a partial batch would leave the
      // author with posts they never agreed to publish.
      expect(hoisted.create).not.toHaveBeenCalled();
    }
  });
});

describe('createThread — a scheduled batch stays invisible until it publishes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Post.prototype, 'save').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits no real-time feed update for a scheduled batch', async () => {
    const { res } = buildResponse();
    await createThread(buildRequest(beastBody({ scheduledFor: FUTURE })) as never, res as never);

    // Pushing an unpublished post into live feeds shows subscribers a row the
    // ACL then refuses to open.
    expect(hoisted.emit).not.toHaveBeenCalled();
  });

  it('still emits for an unscheduled batch, so the suppression is about SCHEDULING', async () => {
    const { res } = buildResponse();
    await createThread(buildRequest(beastBody()) as never, res as never);

    expect(hoisted.emit).toHaveBeenCalled();
  });

  it('notifies nobody of a mention in a scheduled batch', async () => {
    const { res } = buildResponse();
    await createThread(
      buildRequest(
        beastBody({
          scheduledFor: FUTURE,
          posts: [{ content: { text: 'Hi @someone' }, mentions: ['user_2'] }],
        }),
      ) as never,
      res as never,
    );

    // `publishScheduledPost` runs this same stage at the publish moment. Firing
    // it here links people to a post they cannot read yet.
    expect(hoisted.createMentionNotifications).not.toHaveBeenCalled();
  });

  it('DOES notify for an unscheduled batch, so the suppression is about scheduling', async () => {
    const { res } = buildResponse();
    await createThread(
      buildRequest(beastBody({ posts: [{ content: { text: 'Hi @someone' }, mentions: ['user_2'] }] })) as never,
      res as never,
    );

    expect(hoisted.createMentionNotifications).toHaveBeenCalledTimes(1);
  });
});
