import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `createThread` hands the whole batch to outbound federation once the rows are
 * written.
 *
 * This is the wiring the endpoint was missing entirely: `createThread` suppresses
 * `PostCreationService`'s side-effect stage (it runs its own notifications and
 * one socket emit), and the federation stage lives behind that same early
 * return — so a PUBLISHED thread federated nothing while the same thread
 * SCHEDULED federated completely, because the scheduled publisher runs the full
 * pipeline per entry when the time arrives.
 *
 * Three properties, and each fixture is built so the wrong answer is a different
 * answer:
 *
 *  - a thread is handed over as a `chain` and a beast batch as `independent`,
 *    which is what decides whether one entry that cannot go out stops the rest,
 *    so both modes are driven through the same assertion;
 *  - the entries are the created DOCUMENTS in publication order — a chain
 *    federated out of order is a reply arriving before the post it answers;
 *  - a SCHEDULED batch is not handed over at all, because its rows are not
 *    published and `ScheduledPostPublisher` federates each one when it goes
 *    live. The scheduled case uses the SAME body as the published one plus a
 *    time, so nothing but the schedule can explain the difference.
 */

const { federatePostBatchDetached } = vi.hoisted(() => ({
  federatePostBatchDetached: vi.fn(),
}));

vi.mock('../../connectors/threadFederation', () => ({ federatePostBatchDetached }));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => undefined),
}));

import { Post } from '../../models/Post';

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    create: vi.fn(async (params: Record<string, unknown>) => {
      return new Post({
        oxyUserId: params.publishAsOxyUserId ?? params.oxyUserId,
        content: params.content,
        visibility: params.visibility,
        ...(params.status ? { status: params.status } : {}),
        ...(params.parentPostId ? { parentPostId: params.parentPostId } : {}),
        ...(params.threadId ? { threadId: params.threadId } : {}),
      });
    }),
  },
}));

import { createThread } from '../../controllers/posts.controller';

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
  const payload: { value?: { posts: Array<{ _id: unknown }> }; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: { posts: Array<{ _id: unknown }> }) {
      payload.value = body;
      return this;
    },
  };
  return { res, payload };
}

/** The single batch handed to federation. */
function handedOver(): { entries: Array<{ _id: unknown }>; shape: string } {
  expect(federatePostBatchDetached).toHaveBeenCalledTimes(1);
  return federatePostBatchDetached.mock.calls[0][0] as {
    entries: Array<{ _id: unknown }>;
    shape: string;
  };
}

const THREE_POSTS = [
  { content: { text: 'Root post' } },
  { content: { text: 'Continuation 1' } },
  { content: { text: 'Continuation 2' } },
];

describe('createThread — handing the batch to outbound federation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Post.prototype, 'save').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands a thread over as a CHAIN, with every entry in publication order', async () => {
    const req = buildRequest({ mode: 'thread', posts: THREE_POSTS });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    const batch = handedOver();
    expect(batch.shape).toBe('chain');
    // The ids the response returned, in the same order — so this pins the ORDER
    // and not merely the count.
    expect(batch.entries.map((e) => String(e._id))).toEqual(
      (payload.value?.posts ?? []).map((p) => String(p._id)),
    );
    expect(batch.entries).toHaveLength(3);
  });

  it('hands a beast batch over as INDEPENDENT', async () => {
    const req = buildRequest({
      mode: 'beast',
      posts: [{ content: { text: 'One' } }, { content: { text: 'Two' } }],
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    const batch = handedOver();
    expect(batch.shape).toBe('independent');
    expect(batch.entries).toHaveLength(2);
  });

  it('hands over nothing when the batch is SCHEDULED', async () => {
    // The same body as the chain case above plus a time. Its rows are written
    // `status: 'scheduled'` and nobody may read them yet; the scheduled publisher
    // federates each entry at the moment it goes live.
    const req = buildRequest({
      mode: 'thread',
      posts: THREE_POSTS,
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    expect(federatePostBatchDetached).not.toHaveBeenCalled();
  });
});
