/**
 * `GET /posts/:id/edit-source`, against real rows.
 *
 * ## Why this suite was rewritten rather than translated
 *
 * The previous version mocked `Post.findOne` and asserted that the controller
 * had CALLED it with `{ _id, oxyUserId }`. The ownership case went further and
 * had the MOCK implement the security property — its `lean()` returned `null`
 * when the filter named a different viewer — so the test proved that the mock
 * honoured ownership, not that the query did. Delete the `oxyUserId` clause from
 * the real query and that suite stayed green: `findOne` would still have been
 * called with an object containing the key the assertion looked for, because the
 * assertion compared the argument, and the fake would still have returned `null`
 * for the viewer it was told to refuse.
 *
 * Here the boundary is a real row owned by someone else, read through the real
 * predicate. Remove the ownership clause and the draft comes back with a 200.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import { inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

const { resolveUserSummaries } = vi.hoisted(() => ({ resolveUserSummaries: vi.fn() }));

// Oxy owns identity and is reached over HTTP; the ROW is what this suite is
// about, so the identity resolver is the one thing still doubled.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries,
  isFallbackUserSummary: (user: { username?: string }) => !user.username,
}));

// `utils/oxyHelpers` is deliberately NOT doubled. The controller only reaches
// it for `createUserScopedOxyServices(req)`, and the real one returns
// `undefined` for a request carrying no bearer — which is exactly what a stub
// would have returned, while a module factory would silently blank every other
// export the controller graph reads. `utils/logger` is already mocked globally
// in `__tests__/setup.ts`.
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { insertPostRecord } from '../../db/posts/postRepository';
import { getPostEditSource } from '../../controllers/postEditSource.controller';

const OWNER = 'oxy-edit-source-owner';
const OTHER = 'oxy-edit-source-other';
/** A channel account: authored by nobody who can sign in as it. */
const CHANNEL = 'oxy-edit-source-channel';

let db: Database;

function responseDouble() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

function request(postId: string, userId?: string): OxyAuthRequest {
  return {
    params: { id: postId },
    user: userId ? { id: userId } : undefined,
  } as unknown as OxyAuthRequest;
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveUserSummaries.mockResolvedValue(new Map());
});

afterEach(async () => {
  await db.delete(posts).where(inArray(posts.oxyUserId, [OWNER, OTHER, CHANNEL]));
});

afterAll(async () => {
  await closePostgres();
});

describe('getPostEditSource', () => {
  it('requires an authenticated caller', async () => {
    const res = responseDouble();
    await getPostEditSource(request('any-id'), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns the raw author bodies and drops orphan mention ids', async () => {
    const post = await insertPostRecord({
      // A real row always names its author, and the handler authorizes on it
      // (`postManagementRefusal`) rather than on the query filter.
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.IMAGE,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: {
        variants: [
          { source: 'author', tag: 'en', text: 'Hello [mention:alice-id]' },
          { source: 'author', tag: 'es', text: 'Hola [mention:bob-id]' },
          { source: 'machine', tag: 'it', text: 'Ciao [mention:machine-id]' },
        ],
        media: [{ id: 'media-1', type: 'image' }],
      },
      // `orphan-id` and `machine-id` are declared but appear in no AUTHOR body,
      // so the reconciled allowlist must drop them: an orphan id would otherwise
      // survive an edit and notify somebody the post never mentioned.
      mentions: ['orphan-id', 'bob-id', 'alice-id', 'machine-id'],
    });

    resolveUserSummaries.mockResolvedValue(
      new Map([
        ['alice-id', { user: { id: 'alice-id', username: 'alice', name: { displayName: 'Alice' } } }],
        // An unresolvable mention degrades to an EMPTY username and is skipped —
        // the ghost-handle rule: never render a raw id as a handle.
        ['bob-id', { user: { id: 'bob-id', username: '', name: { displayName: 'Unknown user' } } }],
      ]),
    );

    const res = responseDouble();
    await getPostEditSource(request(post.id, OWNER), res as unknown as Response);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      id: post.id,
      content: {
        text: 'Hello [mention:alice-id]',
        // MACHINE renditions are excluded: an edit surface must show only what
        // the author actually wrote.
        variants: [
          { source: 'author', tag: 'en', text: 'Hello [mention:alice-id]' },
          { source: 'author', tag: 'es', text: 'Hola [mention:bob-id]' },
        ],
        media: [{ id: 'media-1', type: 'image' }],
      },
      mentions: ['alice-id', 'bob-id'],
      // Sent unconditionally: the column is `NOT NULL`, and the composer needs
      // it to know whether the 30-minute edit window applies at all.
      status: 'published',
      mentionUsers: [{ id: 'alice-id', username: 'alice', name: { displayName: 'Alice' } }],
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    });
  });

  /**
   * THE security case, and the reason the suite runs on real rows.
   *
   * The boundary MOVED: the lookup is by id alone now, so the query finds this
   * draft and `postManagementRefusal` is the only thing that stops it being
   * served. That is what makes this fixture load-bearing — a viewer-scoped query
   * answering `null` would pass whether the authorization check existed or not.
   *
   * Mutation: delete the `postManagementRefusal` call from the controller and
   * this goes red with a 200 and the draft's body in the response.
   */
  it("does not reveal another owner's draft", async () => {
    const draft = await insertPostRecord({
      oxyUserId: OTHER,
      authorship: [{ oxyUserId: OTHER, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PRIVATE,
      status: 'draft',
      content: { variants: [{ source: 'author', text: 'private draft [mention:alice-id]' }] },
      mentions: ['alice-id'],
    });

    const res = responseDouble();
    await getPostEditSource(request(draft.id, OWNER), res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    // Nothing of the draft may reach the caller — not its body, not its
    // existence beyond the same 404 a missing post answers.
    expect(res.json).toHaveBeenCalledWith({ message: 'Post not found' });
  });

  it('serves the owner their own draft, so the 404 above is not vacuous', async () => {
    const draft = await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PRIVATE,
      status: 'draft',
      content: { variants: [{ source: 'author', text: 'my draft' }] },
    });

    const res = responseDouble();
    await getPostEditSource(request(draft.id, OWNER), res as unknown as Response);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: draft.id, content: expect.objectContaining({ text: 'my draft' }) }),
    );
  });

  it('404s an id of a shape no row has, without a CastError', async () => {
    // The `ObjectId.isValid` guard is gone. A malformed id simply matches no row,
    // which is the same 404 the guard was standing in for — and a uuid v7, which
    // the guard would have rejected outright, now resolves normally.
    const res = responseDouble();
    await getPostEditSource(request('not-an-id-of-any-shape', OWNER), res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Post not found' });
  });

  it("lets a CHANNEL post's writer open it, though the channel is the author", async () => {
    // The defect this route shares with `updatePost`: a channel post is authored
    // by an account nobody can sign in as, so an owner-scoped lookup refused the
    // composer to the very person who wrote it. The row here is the real shape —
    // `oxy_user_id` is the CHANNEL and `written_by_oxy_user_id` is the human — so
    // a query narrowed back to the viewer finds nothing and this goes red.
    //
    // It costs no Oxy round trip: `canManagePostWithoutLookup` answers from the
    // two columns already in hand, which is why the writer is admitted even
    // though `memberReader` is `undefined` here.
    const post = await insertPostRecord({
      oxyUserId: CHANNEL,
      writtenByOxyUserId: OWNER,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'from the channel' }] },
    });

    const res = responseDouble();
    await getPostEditSource(request(post.id, OWNER), res as unknown as Response);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: post.id,
        content: expect.objectContaining({ text: 'from the channel' }),
      }),
    );
  });

  it('refuses the same channel post to somebody who neither wrote it nor operates it', async () => {
    // The vacuity floor for the case above: admitting the WRITER must not be
    // admitting everybody. `OTHER` wrote nothing and Oxy resolves no membership
    // here, so `postManagementRefusal` falls through to its 404.
    const post = await insertPostRecord({
      oxyUserId: CHANNEL,
      writtenByOxyUserId: OWNER,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'from the channel' }] },
    });

    const res = responseDouble();
    await getPostEditSource(request(post.id, OTHER), res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Post not found' });
  });

  it('serves a post whose id is a uuid v7', async () => {
    const post = await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'post-cutover' }] },
    });
    // Every post created after the cutover carries one; the deleted guard would
    // have 404'd all of them.
    expect(post.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const res = responseDouble();
    await getPostEditSource(request(post.id, OWNER), res as unknown as Response);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('reports the parent id for a reply', async () => {
    const parent = await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'root' }] },
    });
    const reply = await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      parentPostId: parent.id,
      content: { variants: [{ source: 'author', text: 'reply' }] },
    });

    const res = responseDouble();
    await getPostEditSource(request(reply.id, OWNER), res as unknown as Response);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ parentPostId: parent.id }),
    );
  });

  it('still serves the source when identity resolution fails', async () => {
    // The ids and placeholders are what preserve the edit; Oxy being unreachable
    // must degrade the display, never make the body unreadable.
    const post = await insertPostRecord({
      oxyUserId: OWNER,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'hi [mention:alice-id]' }] },
      mentions: ['alice-id'],
    });
    resolveUserSummaries.mockRejectedValue(new Error('oxy unreachable'));

    const res = responseDouble();
    await getPostEditSource(request(post.id, OWNER), res as unknown as Response);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: ['alice-id'], mentionUsers: [] }),
    );
  });
});
