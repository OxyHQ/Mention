/**
 * The `hashtags` list `PUT /posts/:id` accepts, in both directions.
 *
 * It was handed to `mergeHashtags` at TWO separate points — once when the body
 * changes, once as a field of its own — and that function calls `.map` on
 * whatever it is given: a truthy non-array was a `TypeError` and a 500. Neither
 * point applied a count or length bound either, while `POST /posts` refused
 * both.
 *
 * The post under edit is a REAL ROW and every assertion reads the STORED tags
 * back, because a refusal and an applied edit look the same from the response.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

const hoisted = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveCollaboratorRefs: vi.fn(),
  emitPostCreated: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
  createUserScopedOxyServices: vi.fn(() => undefined),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

vi.mock('../../services/PostCollaborationService', () => ({
  postCollaborationService: {
    resolveCollaboratorRefs: hoisted.resolveCollaboratorRefs,
    attachCollaborators: vi.fn(),
    autoAcceptInvites: vi.fn(),
    notifyPendingInvites: vi.fn(),
  },
  CollabValidationError: class extends Error {},
  CollabStateError: class extends Error {},
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: hoisted.emitPostCreated,
  emitTombstone: vi.fn(),
  postRecordUri: () => 'at://test',
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { updatePost } from '../../controllers/posts/updatePost';

const scope = serviceScope('update-post-hashtag-validation');
const USER_ID = scope.user('author');

/** The post under edit. Assigned by `seedTarget`, before any request is built. */
let POST_ID = '';

async function seedTarget(): Promise<void> {
  const record = await seedPost(scope, {
    oxyUserId: USER_ID,
    status: 'published',
    // Inside the 30-minute edit window, so nothing here is refused for age.
    createdAt: new Date(),
    hashtags: ['seeded'],
    content: { variants: [{ tag: 'en', source: 'author', text: 'original' }] },
  });
  POST_ID = record.id;
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
  const captured: { status?: number; body?: { message?: string } } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: { message?: string }) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

async function edit(body: Record<string, unknown>) {
  const { res, captured } = buildResponse();
  await updatePost(buildRequest(body) as never, res as never);
  return captured;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.createScopedOxyClient.mockReturnValue(undefined);
  hoisted.hydratePosts.mockImplementation(async () => [{ id: POST_ID }]);
  hoisted.resolveCollaboratorRefs.mockResolvedValue(undefined);
  await seedTarget();
});

afterEach(async () => {
  await clearServiceScope(scope);
});

describe('hashtags on the edit path', () => {
  it('refuses a truthy non-array with a 400 rather than a TypeError, leaving the post as it was', async () => {
    const captured = await edit({ hashtags: 'cat' });

    expect(captured.status).toBe(400);
    expect(captured.body?.message).toContain('Invalid hashtag');
    expect((await readPost(POST_ID))?.hashtags).toEqual(['seeded']);
  });

  it('applies the SAME bounds `POST /posts` applies, which this path had none of', async () => {
    const tooMany = await edit({ hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body?.message).toContain('Too many hashtags');

    const tooLong = await edit({ hashtags: ['x'.repeat(101)] });
    expect(tooLong.status).toBe(400);

    expect((await readPost(POST_ID))?.hashtags).toEqual(['seeded']);
  });

  it('refuses one supplied alongside a body change, which reads the field at a SECOND point', async () => {
    const captured = await edit({ content: { text: 'rewritten' }, hashtags: 'cat' });

    expect(captured.status).toBe(400);
    const stored = await readPost(POST_ID);
    expect(stored?.hashtags).toEqual(['seeded']);
    expect(stored?.content.variants?.[0]?.text).toBe('original');
  });

  it('still replaces the tags when a valid array is sent', async () => {
    await edit({ hashtags: ['Cat', 'ART'] });

    expect((await readPost(POST_ID))?.hashtags).toEqual(['cat', 'art']);
  });

  it('still lets an EXPLICIT tag list win over the ones re-derived from a changed body', async () => {
    // Unchanged, and deliberately pinned: the handler writes `patch.hashtags`
    // twice when an edit changes the body AND names tags — once merged with the
    // new body's inline tags, then again from the supplied list alone — and the
    // second write is the one that lands. Both now read the SAME parsed value,
    // so the two can no longer disagree about what the list even was.
    await edit({ content: { text: 'rewritten with #Tags' }, hashtags: ['extra'] });

    const stored = await readPost(POST_ID);
    expect(stored?.hashtags).toEqual(['extra']);
    expect(stored?.content.variants?.[0]?.text).toBe('rewritten with #Tags');
  });

  it('still keeps the stored tags when the body changes and no tags are sent', async () => {
    await edit({ content: { text: 'rewritten' } });

    expect((await readPost(POST_ID))?.hashtags).toEqual(['seeded']);
  });
});
