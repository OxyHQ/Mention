import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 */

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

import { Post } from '../../models/Post';
import ArticleModel from '../../models/Article';
import type { PostContent } from '@mention/shared-types';

const createdContents: PostContent[] = [];
const createdHashtags: string[][] = [];

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    create: vi.fn(async (params: Record<string, unknown>) => {
      createdContents.push(params.content as PostContent);
      createdHashtags.push((params.hashtags as string[]) ?? []);
      return new Post({
        oxyUserId: params.oxyUserId,
        content: params.content,
        visibility: params.visibility,
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

beforeEach(() => {
  createdContents.length = 0;
  createdHashtags.length = 0;
  vi.spyOn(Post.prototype, 'save').mockResolvedValue(undefined as never);
  vi.spyOn(ArticleModel.prototype, 'save').mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
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
