import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two pieces of an entry's content that `createThread` used to discard, and the
 * batch-level refusal that keeps a bad one from writing half a thread.
 *
 * Both losses were silent — a 201 with the content quietly gone — and both are
 * pinned here from the entry that actually loses it (never the root, which was
 * always handled):
 *
 *  - **language renditions.** The loop rebuilt each entry's content field by
 *    field and never carried `content.variants`, so every entry of a
 *    multilingual thread stored only the plain `content.text` and lost every
 *    rendition it was written in. The primary rendition's text is also the BODY,
 *    so the fixtures give `variants[0].text` a different value from
 *    `content.text` — a loop that kept the variants but the wrong body would
 *    otherwise pass.
 *  - **articles.** `content.article` was read from `posts[0]` only, in BOTH
 *    modes, so an article attached to any other box was dropped. The fixtures
 *    therefore put an article on a NON-root entry.
 *
 * ## What the Postgres port changed
 *
 * Nothing about the subject. What is measured is the content the CONTROLLER
 * composes and hands to `PostCreationService.create` — that is upstream of any
 * store, so the stub still captures it. It answers with a `PostRecord`-shaped
 * value (`id`, not a Mongoose `_id`) because that is what the controller now
 * chains and hydrates on, and the article write is `insertArticle` against the
 * `articles` table rather than a Mongoose save.
 */

import type { PostContent } from '@mention/shared-types';

const { createdContents, createdHashtags, ids } = vi.hoisted(() => ({
  createdContents: [] as PostContent[],
  createdHashtags: [] as string[][],
  /** A per-request id sequence, so an entry's identity is its own. */
  ids: { next: 0 },
}));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

vi.mock('../../connectors/threadFederation', () => ({
  federatePostBatchDetached: vi.fn(),
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

// `newArticleId` stays REAL — the assertions below are about the id the
// controller mints landing on the right entry's content. Only the write is
// stubbed: `articles.post_id` is a foreign key and the posts here are a stub's
// invention, so a real insert would fail (harmlessly, in a `catch`) and say
// nothing about the subject.
vi.mock('../../db/posts/articleRepository', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertArticle: vi.fn(async () => undefined),
}));

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    create: vi.fn(async (params: Record<string, unknown>) => {
      createdContents.push(params.content as PostContent);
      createdHashtags.push((params.hashtags as string[]) ?? []);
      return {
        id: `ctc-created-${ids.next++}`,
        oxyUserId: params.oxyUserId,
        mentions: [],
        content: params.content,
        visibility: params.visibility,
        status: params.status ?? 'published',
        parentPostId: params.parentPostId ?? null,
        threadId: params.threadId ?? null,
      };
    }),
  },
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { createThread } from '../../controllers/posts.controller';

function buildRequest(body: Record<string, unknown>) {
  return {
    user: { id: 'ctc-author-1' },
    query: {},
    acceptsLanguages: () => [] as string[],
    headers: {},
    body,
  };
}

function buildResponse() {
  const payload: { value?: { message?: string }; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: { message?: string }) {
      payload.value = body;
      return this;
    },
  };
  return { res, payload };
}

beforeAll(async () => {
  // The controller anchors a thread's root with a real `updatePostRecord`, so
  // the pool has to exist even though the ids here name no row.
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  createdContents.length = 0;
  createdHashtags.length = 0;
  ids.next = 0;
});

describe('createThread — author language renditions', () => {
  it('stores every entry\'s renditions, and takes the body from the primary one', async () => {
    const req = buildRequest({
      mode: 'thread',
      posts: [
        {
          content: {
            // `text` deliberately disagrees with the primary rendition: the
            // rendition is what a reader sees, so a loop that stored `text`
            // would be storing a body nobody wrote.
            text: 'ignored root text',
            variants: [
              { tag: 'en', text: 'Root in English' },
              { tag: 'es', text: 'Raíz en español' },
            ],
          },
        },
        {
          content: {
            text: 'ignored continuation text',
            variants: [
              { tag: 'en', text: 'Continuation in English' },
              { tag: 'es', text: 'Continuación en español' },
            ],
          },
        },
      ],
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    expect(createdContents).toHaveLength(2);

    // The CONTINUATION is the entry that used to lose this.
    expect(createdContents[1].variants?.map((v) => v.tag)).toEqual(['en', 'es']);
    expect(createdContents[1].variants?.map((v) => v.text)).toEqual([
      'Continuation in English',
      'Continuación en español',
    ]);
    expect(createdContents[1].text).toBe('Continuation in English');

    expect(createdContents[0].variants?.map((v) => v.tag)).toEqual(['en', 'es']);
    expect(createdContents[0].text).toBe('Root in English');
  });

  it('reads hashtags off the rendition that is stored, not the discarded text', async () => {
    // The two strings carry DIFFERENT tags, so a reader pointed at the wrong one
    // produces a different answer rather than the same one by luck.
    const req = buildRequest({
      mode: 'thread',
      posts: [
        { content: { text: 'root' } },
        {
          content: {
            text: 'discarded text #discarded',
            variants: [{ tag: 'en', text: 'stored rendition #stored' }],
          },
        },
      ],
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    expect(createdHashtags[1]).toContain('stored');
    expect(createdHashtags[1]).not.toContain('discarded');
  });

  it('leaves a plain single-language entry exactly as it was', async () => {
    const req = buildRequest({
      mode: 'thread',
      posts: [{ content: { text: 'Just one language' } }],
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    expect(createdContents[0].text).toBe('Just one language');
    expect(createdContents[0].variants).toBeUndefined();
  });

  it('refuses a bad rendition for the WHOLE batch before writing anything', async () => {
    // Entry 2 is the invalid one. A refusal raised mid-loop would already have
    // written entry 1 — half a thread nobody can undo in one action — so the
    // assertion is that NOTHING was created, not merely that it 400s.
    const req = buildRequest({
      mode: 'thread',
      posts: [
        { content: { text: 'fine' } },
        { content: { text: 'bad', variants: 'not-an-array' } },
      ],
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(400);
    expect(payload.value?.message).toContain('variants');
    expect(createdContents).toHaveLength(0);
  });
});

describe('createThread — an article on a non-root entry', () => {
  it('keeps the article a BEAST batch attached to its second box', async () => {
    const req = buildRequest({
      mode: 'beast',
      posts: [
        { content: { text: 'plain post' } },
        {
          content: {
            text: 'the one with the article',
            article: { title: 'Second box article', body: 'Body of the article.' },
          },
        },
      ],
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    expect(createdContents[0].article).toBeUndefined();
    expect(createdContents[1].article?.title).toBe('Second box article');
    expect(createdContents[1].article?.articleId).toEqual(expect.any(String));
  });

  it('keeps the article a THREAD attached to a continuation', async () => {
    const req = buildRequest({
      mode: 'thread',
      posts: [
        { content: { text: 'root' } },
        {
          content: {
            text: 'continuation with an article',
            article: { title: 'Continuation article', body: 'Body of the article.' },
          },
        },
      ],
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    expect(createdContents[0].article).toBeUndefined();
    expect(createdContents[1].article?.title).toBe('Continuation article');
  });

  it('still keeps an article on the root', async () => {
    const req = buildRequest({
      mode: 'thread',
      posts: [
        {
          content: {
            text: 'root with an article',
            article: { title: 'Root article', body: 'Body of the article.' },
          },
        },
        { content: { text: 'continuation' } },
      ],
    });
    const { res, payload } = buildResponse();

    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    expect(createdContents[0].article?.title).toBe('Root article');
    expect(createdContents[1].article).toBeUndefined();
  });
});
