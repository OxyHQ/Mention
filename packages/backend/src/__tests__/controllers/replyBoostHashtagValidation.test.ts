/**
 * `hashtags` on the other two native post writes.
 *
 * A reply and a boost ARE posts, written by `feed.controller` rather than by the
 * `controllers/posts/` handlers, and both carried the same unread `hashtags`
 * into `mergeHashtags`. `CreateReplyRequest` / `CreateBoostRequest` type the
 * field `string[]`, which is a compile-time claim about a value that arrives as
 * JSON — so `hashtags: "cat"` reached `(userProvided || []).map` and answered
 * **500 with the internal `TypeError` message in the response body**, measured:
 *
 *   {"error":"Failed to create reply",
 *    "message":"(userProvided || []).map is not a function"}
 *
 * Neither path had a count or length bound either, while `POST /posts` refused
 * both. They now share that route's schema.
 *
 * Real rows throughout: the reply and the boost are inserted, so "still
 * accepted" means a post that actually exists.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: vi.fn(async (objs: object[]) => objs),
    canViewerReadPostId: vi.fn(async () => true),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => undefined),
  getRuntimeOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../utils/linkPreviewWarm', () => ({
  warmLinkPreviewForText: vi.fn().mockResolvedValue(undefined),
  warmLinkPreviewForTextDetached: vi.fn(),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readScopePosts, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { feedController } from '../../controllers/feed.controller';

const scope = serviceScope('reply-boost-hashtags');
const AUTHOR = scope.user('author');
const TARGET_AUTHOR = scope.user('target-author');

/** The post being replied to / boosted. Re-seeded for every case. */
let TARGET_ID = '';

function buildResponse() {
  const captured: { status?: number; body?: { error?: string; message?: string } } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: { error?: string; message?: string }) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

async function call(
  handler: (req: never, res: never) => Promise<unknown>,
  body: Record<string, unknown>,
) {
  const { res, captured } = buildResponse();
  await handler(
    { user: { id: AUTHOR }, query: {}, headers: {}, acceptsLanguages: () => [], body } as never,
    res as never,
  );
  return captured;
}

const createReply = (body: Record<string, unknown>) =>
  call((req, res) => feedController.createReply(req, res), body);
const createBoost = (body: Record<string, unknown>) =>
  call((req, res) => feedController.createBoost(req, res), body);

/** Every post this scope owns, so "nothing was written" is a real count. */
async function scopePostCount(): Promise<number> {
  return (await readScopePosts(scope)).length;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  const target = await seedPost(scope, {
    oxyUserId: TARGET_AUTHOR,
    status: 'published',
    content: { variants: [{ tag: 'en', source: 'author', text: 'the target' }] },
  });
  TARGET_ID = target.id;
});

afterEach(async () => {
  await clearServiceScope(scope);
});

describe('createReply', () => {
  it('refuses a truthy non-array with a 400 and writes nothing', async () => {
    const captured = await createReply({ postId: TARGET_ID, content: { text: 'a reply' }, hashtags: 'cat' });

    expect(captured.status).toBe(400);
    expect(captured.body?.error).toContain('Invalid hashtag');
    // The internal `TypeError` text must not travel to the client any more.
    expect(JSON.stringify(captured.body)).not.toContain('is not a function');
    expect(await scopePostCount()).toBe(1);
  });

  it('applies the count and length bounds this path had none of', async () => {
    const tooMany = await createReply({
      postId: TARGET_ID,
      content: { text: 'a reply' },
      hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body?.error).toContain('Too many hashtags');
    expect(await scopePostCount()).toBe(1);
  });

  it('still writes a reply with tags, merged with the ones in the body', async () => {
    const captured = await createReply({
      postId: TARGET_ID,
      content: { text: 'a reply about #Cats' },
      hashtags: ['Art'],
    });

    expect(captured.status).toBe(201);
    const posts = await readScopePosts(scope);
    expect(posts).toHaveLength(2);
    expect(posts.find((p) => p.id !== TARGET_ID)?.hashtags).toEqual(['art', 'cats']);
  });

  it('still writes a reply with no tags at all', async () => {
    const captured = await createReply({ postId: TARGET_ID, content: { text: 'a reply' } });

    expect(captured.status).toBe(201);
    expect(await scopePostCount()).toBe(2);
  });
});

describe('createBoost', () => {
  it('refuses a truthy non-array with a 400 and writes nothing', async () => {
    const captured = await createBoost({ originalPostId: TARGET_ID, content: { text: 'a boost' }, hashtags: 'cat' });

    expect(captured.status).toBe(400);
    expect(captured.body?.error).toContain('Invalid hashtag');
    expect(await scopePostCount()).toBe(1);
  });

  it('still writes a boost with tags', async () => {
    const captured = await createBoost({
      originalPostId: TARGET_ID,
      content: { text: 'a boost about #Cats' },
      hashtags: ['Art'],
    });

    expect(captured.status).toBe(201);
    const posts = await readScopePosts(scope);
    expect(posts).toHaveLength(2);
    expect(posts.find((p) => p.id !== TARGET_ID)?.hashtags).toEqual(['art', 'cats']);
  });
});
