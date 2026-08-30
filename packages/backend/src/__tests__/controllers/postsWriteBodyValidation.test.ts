/**
 * What `POST /posts` and `POST /posts/thread` accept, in both directions.
 *
 * Four client fields reached a constrained column unread on these two routes,
 * and each was a **500** for a body a client can trivially send:
 *
 *  - `hashtags` went to `mergeHashtags`, which does `(userProvided || []).map`,
 *    so any truthy NON-array was a `TypeError`. On `POST /posts` the bounds that
 *    were supposed to catch it sat behind `if (Array.isArray(hashtags))` — the
 *    guard SKIPPED validation for exactly the value that then blew up. The
 *    thread path had no bound of any kind.
 *  - `visibility` was `(visibility as PostVisibility) || PUBLIC` on the thread
 *    path: a cast of request input into a column guarded by
 *    `posts_visibility_check`.
 *  - `replyPermission` was `x || ['anyone']` on BOTH paths, into a `text[]`
 *    guarded by `posts_reply_permission_check`.
 *  - `content.poll`'s question and options were inserted verbatim and unbounded.
 *
 * On the THREAD path every one of those raised inside the creation loop, which
 * writes entries one at a time — so a bad third entry left the first two
 * published, the half-thread the handler's other pre-flights exist to prevent.
 * The cases below therefore put the offending value on a NON-ROOT entry and
 * assert that NOTHING was created.
 *
 * The other half of the file is the part that makes it a test rather than a
 * restatement: every shape a real client sends — including the awkward ones the
 * composer really produces, a ONE-option poll and a poll whose question is the
 * whole post body — is asserted to still publish.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PostContent } from '@mention/shared-types';

const { created, ids } = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  ids: { next: 0 },
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../connectors/threadFederation', () => ({ federatePostBatchDetached: vi.fn() }));
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
vi.mock('../../db/posts/articleRepository', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertArticle: vi.fn(async () => undefined),
}));

/**
 * `createPollWithOptions` stays REAL — it is the insert whose bounds this file
 * is about, and a stub could not tell a rejected two-hundred-option poll from an
 * accepted one. Only the LINK back to the post is stubbed: `polls.post_id` is a
 * foreign key and the posts here are the `PostCreationService` stub's invention,
 * so a real `attachPollToPost` would fail on an id that names no row (and the
 * thread path does not wrap that call in a `try`).
 */
vi.mock('../../db/polls/pollRepository', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attachPollToPost: vi.fn(async () => undefined),
}));

/**
 * `PostCreationService.create` is stubbed, and that is what makes "nothing was
 * created" assertable: it records the parameters each entry would be written
 * with, so a refusal shows up as an empty array rather than as rows nobody
 * counted. The values it records are the ones the CONTROLLER resolved, which is
 * the subject — `visibility` and `replyPermission` are read straight off them.
 */
vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    create: vi.fn(async (params: Record<string, unknown>) => {
      created.push(params);
      return {
        id: `pwv-${ids.next++}`,
        oxyUserId: params.oxyUserId,
        mentions: [],
        hashtags: params.hashtags,
        content: params.content,
        visibility: params.visibility,
        status: params.status ?? 'published',
        parentPostId: params.parentPostId ?? null,
        threadId: params.threadId ?? null,
      };
    }),
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { polls } from '../../db/schema/polls';
import { inArray } from 'drizzle-orm';
import { createPost } from '../../controllers/posts/createPost';
import { createThread } from '../../controllers/posts/createThread';

const AUTHOR = 'pwv-author';

/** Poll ids this file created, so the rows do not outlive the run. */
const createdPollIds: string[] = [];

function buildRequest(body: Record<string, unknown>) {
  return {
    user: { id: AUTHOR },
    query: {},
    acceptsLanguages: () => [] as string[],
    headers: {},
    body,
  };
}

function buildResponse() {
  const captured: { status?: number; body?: { message?: string; error?: string } } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: { message?: string; error?: string }) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

type Handler = (req: never, res: never) => Promise<unknown>;

async function call(handler: Handler, body: Record<string, unknown>) {
  const { res, captured } = buildResponse();
  await handler(buildRequest(body) as never, res as never);
  for (const params of created) {
    const pollId = (params.content as PostContent | undefined)?.pollId;
    if (typeof pollId === 'string') createdPollIds.push(pollId);
  }
  return captured;
}

/** A single-post body that publishes, with `overrides` merged over it. */
function post(overrides: Record<string, unknown> = {}) {
  return { content: { text: 'a post' }, ...overrides };
}

/** A two-entry thread whose SECOND entry carries `entry`. */
function thread(entry: Record<string, unknown>) {
  return { mode: 'thread', posts: [{ content: { text: 'root' } }, { content: { text: 'tail' }, ...entry }] };
}

beforeAll(async () => {
  // The thread handler anchors its root with a real `updatePostRecord`, and the
  // poll cases below insert real rows, so the pool has to exist.
  await connectPostgres();
});

afterAll(async () => {
  if (createdPollIds.length > 0) {
    await getDb().delete(polls).where(inArray(polls.id, createdPollIds));
  }
  await closePostgres();
});

beforeEach(() => {
  created.length = 0;
  ids.next = 0;
});

describe('hashtags — a truthy non-array was a 500 on every create path', () => {
  it('refuses a STRING `hashtags` with a 400 instead of a TypeError', async () => {
    const captured = await call(createPost, post({ hashtags: 'cat' }));

    expect(captured.status).toBe(400);
    expect(captured.body?.message).toContain('Invalid hashtag');
    expect(created).toHaveLength(0);
  });

  it('refuses one on a thread ENTRY before any entry is written', async () => {
    const captured = await call(createThread, thread({ hashtags: 'cat' }));

    expect(captured.status).toBe(400);
    // The root would have been published by the old loop, which validated
    // nothing until it reached the entry that failed.
    expect(created).toHaveLength(0);
  });

  it('still accepts the array every composer sends, still lowercased and merged', async () => {
    const captured = await call(createPost, post({ content: { text: 'a #Post' }, hashtags: ['Cat', 'art'] }));

    expect(captured.status).toBe(201);
    expect(created[0].hashtags).toEqual(['cat', 'art', 'post']);
  });

  it('still accepts no hashtags at all, and a falsy value still means none', async () => {
    for (const hashtags of [undefined, null, '']) {
      created.length = 0;
      const captured = await call(createPost, post({ hashtags }));
      expect(captured.status, `hashtags: ${JSON.stringify(hashtags)}`).toBe(201);
      expect(created[0].hashtags).toEqual([]);
    }
  });

  it('now bounds the thread and update paths that had NO bound', async () => {
    const tooMany = await call(createThread, thread({ hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) }));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body?.message).toContain('Too many hashtags');

    created.length = 0;
    const tooLong = await call(createThread, thread({ hashtags: ['x'.repeat(101)] }));
    expect(tooLong.status).toBe(400);

    // The bound itself is unchanged on `POST /posts` — thirty is still fine.
    created.length = 0;
    const atTheBound = await call(createThread, thread({ hashtags: Array.from({ length: 30 }, (_, i) => `t${i}`) }));
    expect(atTheBound.status).toBe(201);
  });
});

describe('visibility — a cast into a CHECK-constrained column', () => {
  it('refuses an unknown visibility on a thread entry, writing nothing', async () => {
    const captured = await call(createThread, thread({ visibility: 'friends' }));

    expect(captured.status).toBe(400);
    expect(captured.body?.message).toContain('visibility');
    expect(created).toHaveLength(0);
  });

  it('refuses a NON-STRING visibility on a thread entry', async () => {
    const captured = await call(createThread, thread({ visibility: 7 }));

    expect(captured.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('still stores each canonical spelling exactly as it did', async () => {
    for (const visibility of ['public', 'private', 'followers_only']) {
      created.length = 0;
      const captured = await call(createThread, thread({ visibility }));
      expect(captured.status, `visibility: ${visibility}`).toBe(201);
      expect(created[1].visibility).toBe(visibility);
    }
  });

  it('now maps the `followers` alias the thread path used to pass through', async () => {
    // A WIDENING, named as one: `POST /posts` has always accepted `followers` as
    // a spelling of `followers_only`, while the thread path handed it to the
    // column and `posts_visibility_check` refused it (a 500, mid-batch). Sharing
    // one reader is what makes the two routes accept one vocabulary.
    const captured = await call(createThread, thread({ visibility: 'followers' }));

    expect(captured.status).toBe(201);
    expect(created[1].visibility).toBe('followers_only');
  });

  it('still defaults to public when the thread entry names none', async () => {
    const captured = await call(createThread, thread({}));

    expect(captured.status).toBe(201);
    expect(created[1].visibility).toBe('public');
  });

  it('leaves `POST /posts` falling back to public, which it has always done', async () => {
    // Deliberately NOT a 400: narrowing this would refuse bodies that publish
    // today. The thread path cannot afford the same fallback — see the file
    // docblock — and that asymmetry is the point, not an oversight.
    const captured = await call(createPost, post({ visibility: 'friends' }));

    expect(captured.status).toBe(201);
    expect(created[0].visibility).toBe('public');
  });
});

describe('replyPermission — an unchecked `text[]` on BOTH create paths', () => {
  it('refuses an unknown permission', async () => {
    for (const handler of [createPost, createThread] as Handler[]) {
      created.length = 0;
      const body = handler === createPost ? post({ replyPermission: ['banana'] }) : thread({ replyPermission: ['banana'] });
      const captured = await call(handler, body);
      expect(captured.status).toBe(400);
      expect(captured.body?.message).toContain('replyPermission');
      expect(created).toHaveLength(0);
    }
  });

  it('refuses a bare string, which used to be a TypeError inside the driver', async () => {
    const captured = await call(createPost, post({ replyPermission: 'nobody' }));

    expect(captured.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('still accepts every permission the composer offers, and an EMPTY array', async () => {
    for (const replyPermission of [
      ['anyone'],
      ['followers'],
      ['following'],
      ['mentioned'],
      ['nobody'],
      ['followers', 'mentioned'],
      // Admitted by `posts_reply_permission_check` and stored as sent. The
      // application, not the schema, decides what an empty list means.
      [],
    ]) {
      created.length = 0;
      const captured = await call(createPost, post({ replyPermission }));
      expect(captured.status, JSON.stringify(replyPermission)).toBe(201);
      expect(created[0].replyPermission).toEqual(replyPermission);
    }
  });

  it('still defaults to `anyone` when the body names none', async () => {
    const captured = await call(createPost, post());

    expect(captured.status).toBe(201);
    expect(created[0].replyPermission).toEqual(['anyone']);
  });
});

describe('content.poll — inserted verbatim and unbounded', () => {
  it('refuses a question that is not a string, which was stored as "[object Object]"', async () => {
    const captured = await call(createPost, post({ content: { text: 'p', poll: { question: { $ne: null }, options: ['a', 'b'] } } }));

    expect(captured.status).toBe(400);
    expect(captured.body?.message).toContain('question');
    expect(created).toHaveLength(0);
  });

  it('refuses options that are not strings, which became options labelled "[object Object]"', async () => {
    const captured = await call(createPost, post({ content: { text: 'p', poll: { question: 'q', options: [{ text: 'a' }, { text: 'b' }] } } }));

    expect(captured.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('bounds the option COUNT, which used to insert one row per element', async () => {
    const captured = await call(createPost, post({
      content: { text: 'p', poll: { question: 'q', options: Array.from({ length: 200 }, (_, i) => `o${i}`) } },
    }));

    expect(captured.status).toBe(400);
    expect(captured.body?.message).toContain('at most 4 options');
    expect(created).toHaveLength(0);
  });

  it('refuses an EMPTY options array, which published a post carrying an unanswerable poll', async () => {
    const captured = await call(createPost, post({ content: { text: 'p', poll: { question: 'q', options: [] } } }));

    expect(captured.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('refuses a truthy non-boolean flag, which stored the OPPOSITE of what was asked', async () => {
    // `poll.isMultipleChoice || false` put `'yes'` into a `boolean NOT NULL`
    // column, and the driver resolved it to `false`.
    const captured = await call(createPost, post({ content: { text: 'p', poll: { question: 'q', options: ['a', 'b'], isMultipleChoice: 'yes' } } }));

    expect(captured.status).toBe(400);
    expect(captured.body?.message).toContain('isMultipleChoice');
    expect(created).toHaveLength(0);
  });

  it('refuses a malformed poll on a thread ENTRY before any entry is written', async () => {
    const captured = await call(createThread, thread({ content: { text: 'tail', poll: { question: 'q', options: 'ab' } } }));

    expect(captured.status).toBe(400);
    // The thread path never wrapped `createPollWithOptions` in a `try`, so this
    // used to be a 500 with the root already published.
    expect(created).toHaveLength(0);
  });

  it('still publishes the polls the composer really sends', async () => {
    // Every one of these is a shape `frontend/utils/postBuilder.ts` produces.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['two options', { question: 'Which?', options: ['a', 'b'] }],
      ['four options', { question: 'Which?', options: ['a', 'b', 'c', 'd'] }],
      // The composer attaches a poll as soon as ONE option is non-empty and then
      // filters the empties out, so this is a request the app really makes.
      ['one option', { question: 'Which?', options: ['a'] }],
      // With no question typed it sends the post body instead, which may be far
      // longer than the 280 `POST /polls` allows.
      ['the post body as the question', { question: 'x'.repeat(1_000), options: ['a', 'b'] }],
      ['an explicit deadline', { question: 'Which?', options: ['a', 'b'], endTime: new Date(Date.now() + 86_400_000).toISOString() }],
      ['both booleans', { question: 'Which?', options: ['a', 'b'], isMultipleChoice: true, isAnonymous: true }],
    ];

    for (const [label, poll] of cases) {
      created.length = 0;
      const captured = await call(createPost, post({ content: { text: 'p', poll } }));
      expect(captured.status, label).toBe(201);
      expect((created[0].content as PostContent).pollId, label).toEqual(expect.any(String));
    }
  });

  it('still refuses a deadline in the past, and one beyond the maximum duration', async () => {
    const past = await call(createPost, post({ content: { text: 'p', poll: { question: 'q', options: ['a', 'b'], endTime: new Date(Date.now() - 1_000).toISOString() } } }));
    expect(past.status).toBe(400);
    expect(past.body?.message).toContain('future');

    created.length = 0;
    const tooFar = await call(createPost, post({ content: { text: 'p', poll: { question: 'q', options: ['a', 'b'], endTime: new Date(Date.now() + 400 * 86_400_000).toISOString() } } }));
    expect(tooFar.status).toBe(400);
    expect(tooFar.body?.message).toContain('duration');
  });

  it('still accepts a thread poll deadline the single-post path would refuse', async () => {
    // `POST /posts/thread` has never applied the future/duration bounds, and
    // applying them here would refuse threads that publish today.
    const past = await call(createThread, thread({
      content: { text: 'tail', poll: { question: 'q', options: ['a', 'b'], endTime: new Date(Date.now() - 1_000).toISOString() } },
    }));

    expect(past.status).toBe(201);
  });

  it('refuses an UNREADABLE thread poll deadline, which was `ends_at` NOT NULL raised mid-batch', async () => {
    const captured = await call(createThread, thread({
      content: { text: 'tail', poll: { question: 'q', options: ['a', 'b'], endTime: 'not a date' } },
    }));

    expect(captured.status).toBe(400);
    expect(created).toHaveLength(0);
  });
});

describe('the refusals stay behind the 401', () => {
  it('answers 401, not 400, for an unauthenticated caller with a malformed body', async () => {
    for (const handler of [createPost, createThread] as Handler[]) {
      const { res, captured } = buildResponse();
      const req = { ...buildRequest({ hashtags: 'cat', posts: [{ hashtags: 'cat' }] }), user: undefined };
      await handler(req as never, res as never);
      expect(captured.status).toBe(401);
    }
  });
});
