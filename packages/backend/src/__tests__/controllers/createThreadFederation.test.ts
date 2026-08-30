import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
 *  - the entries are the created RECORDS in publication order — a chain
 *    federated out of order is a reply arriving before the post it answers;
 *  - a SCHEDULED batch is not handed over at all, because its rows are not
 *    published and `ScheduledPostPublisher` federates each one when it goes
 *    live. The scheduled case uses the SAME body as the published one plus a
 *    time, so nothing but the schedule can explain the difference.
 *
 * ## What the Postgres port changed
 *
 * An entry is a `PostRecord` — a plain immutable row with `id` — so the stub
 * standing in for `PostCreationService.create` answers with one instead of
 * constructing an unsaved Mongoose document, and the identity assertions read
 * `id`. What the batch carries is otherwise unchanged, which is the point: the
 * ORDER and the SHAPE are the whole contract this endpoint has with
 * `connectors/threadFederation`.
 */

const { federatePostBatchDetached, ids } = vi.hoisted(() => ({
  federatePostBatchDetached: vi.fn(),
  /** A per-request id sequence, so an entry's identity is its own. */
  ids: { next: 0 },
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

vi.mock('../../utils/linkPreviewWarm', () => ({
  warmLinkPreviewForText: vi.fn().mockResolvedValue(undefined),
  warmLinkPreviewForTextDetached: vi.fn(),
}));

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    // The row as a VALUE, which is what `create` now returns. Only the fields
    // the controller reads are stated: it chains on `id`, counts `mentions`, and
    // hands `content` to hydration.
    create: vi.fn(async (params: Record<string, unknown>) => ({
      id: `ctf-created-${ids.next++}`,
      oxyUserId: params.publishAsOxyUserId ?? params.oxyUserId,
      mentions: [],
      content: params.content,
      visibility: params.visibility,
      status: params.status ?? 'published',
      parentPostId: params.parentPostId ?? null,
      threadId: params.threadId ?? null,
    })),
  },
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { createThread } from '../../controllers/posts/createThread';

function buildRequest(body: Record<string, unknown>) {
  return {
    user: { id: 'ctf-author-1' },
    query: {},
    acceptsLanguages: () => [] as string[],
    headers: {},
    body,
  };
}

function buildResponse() {
  const payload: { value?: { posts: Array<{ id: unknown }> }; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: { posts: Array<{ id: unknown }> }) {
      payload.value = body;
      return this;
    },
  };
  return { res, payload };
}

/** The single batch handed to federation. */
function handedOver(): { entries: Array<{ id: unknown }>; shape: string } {
  expect(federatePostBatchDetached).toHaveBeenCalledTimes(1);
  return federatePostBatchDetached.mock.calls[0][0] as {
    entries: Array<{ id: unknown }>;
    shape: string;
  };
}

const THREE_POSTS = [
  { content: { text: 'Root post' } },
  { content: { text: 'Continuation 1' } },
  { content: { text: 'Continuation 2' } },
];

describe('createThread — handing the batch to outbound federation', () => {
  beforeAll(async () => {
    // The controller anchors a thread's root with a real `updatePostRecord`, so
    // the pool has to exist even though the ids here name no row.
    await connectPostgres();
  });

  afterAll(async () => {
    await closePostgres();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ids.next = 0;
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
    expect(batch.entries.map((e) => String(e.id))).toEqual(
      (payload.value?.posts ?? []).map((p) => String(p.id)),
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
