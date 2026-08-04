import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /posts/:id/likes`, `GET /posts/saved` and `GET /posts/bookmarks/folders`
 * — the three readers that moved off Mongoose in the batch-7 port and that
 * nothing in the suite exercised afterwards.
 *
 * They are grouped in one file because they share a subject: each one asks the
 * database a question whose WRONG answer is a plausible right answer. None of
 * the three can fail loudly.
 *
 *  - `getPostLikes` pages a keyset. A broken bound does not error; it repeats or
 *    skips a row at the page edge, which reads as a ranking quirk.
 *  - `getBookmarkFolders` filters `IS NOT NULL`. The literal Mongo translation
 *    (`folder <> null`) evaluates to NULL for every row and returns an EMPTY
 *    list for everyone — a result, not an error.
 *  - `getSavedPosts` escapes an `ILIKE` term. An unescaped `%` matches every
 *    saved post, which looks like a generous search rather than a broken one.
 *
 * ## Why the assertions are all about rows
 *
 * There is nothing else left to assert on. The Mongoose models are gone from
 * `posts.controller.ts`, so there is no filter object to inspect and no `find`
 * to count — and that is the point, because a filter assertion could not have
 * distinguished any of the three failures above from correct behaviour anyway.
 * Everything below seeds rows that must match next to rows that must not.
 *
 * Oxy identity resolution and post hydration stay mocked: they are the network
 * boundary and a separate service respectively, and neither decides WHICH rows
 * come back, which is the whole question here.
 */

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

const hoisted = vi.hoisted(() => ({
  createScopedOxyClient: vi.fn(() => ({})),
  resolveUserSummaries: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
  getServiceOxyClient: () => ({ getUserById: vi.fn(), getUsersByIds: vi.fn(async () => []) }),
}));

vi.mock('../../services/PostHydrationService', () => ({
  // Passthrough: the SELECTION is the subject, and it has already happened by
  // the time hydration runs.
  postHydrationService: { hydratePosts: vi.fn(async (records: object[]) => records) },
  resolveUserSummaries: hoisted.resolveUserSummaries,
  degradedActorSummary: (id: string) => ({
    id,
    username: '',
    name: { displayName: 'Unknown user' },
  }),
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { bookmarks, likes } from '../../db/schema/engagement';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import {
  getBookmarkFolders,
  getPostLikes,
  getSavedPosts,
} from '../../controllers/posts.controller';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = serviceScope('post-likes-bookmarks');
const VIEWER = scope.user('viewer');

function buildRequest(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    ...overrides,
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

/** Resolve these ids to canonical Oxy summaries; anything else stays degraded. */
function resolveSummaries(ids: string[]): void {
  hoisted.resolveUserSummaries.mockResolvedValue(
    new Map(ids.map((id) => [id, { user: { id, username: id, name: { displayName: id } } }])),
  );
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  hoisted.createScopedOxyClient.mockReturnValue({});
  hoisted.resolveUserSummaries.mockResolvedValue(new Map());
});

afterEach(async () => {
  // Both tables are `ON DELETE CASCADE` to `posts.id`, so clearing the scope
  // takes them with it. Ordering note for anyone extending this file: the clear
  // runs in `afterEach` and NOT from any seed helper, so a row seeded inside a
  // test is still there when the assertion runs — batch 6's `clearFederationScope`
  // is reachable from a seed helper and does not have that property, which cost
  // a session convinced a predicate was broken when the rows were simply gone.
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('getPostLikes — the (created_at DESC, id DESC) keyset', () => {
  /**
   * Three likes on one post, each a second apart, newest last.
   *
   * Returned newest-first, which is the order the endpoint pages in.
   */
  async function seedThreeLikes(): Promise<{ post: PostRecord; newestFirst: string[] }> {
    const post = await seedPost(scope, { oxyUserId: scope.user('author') });
    const base = Date.parse('2026-07-01T12:00:00.000Z');
    const users = ['liker-a', 'liker-b', 'liker-c'].map((label) => scope.user(label));
    for (const [index, userId] of users.entries()) {
      await getDb()
        .insert(likes)
        .values({ userId, postId: post.id, value: 1, createdAt: new Date(base + index * 1000) });
    }
    resolveSummaries(users);
    return { post, newestFirst: [...users].reverse() };
  }

  async function page(postId: string, cursor?: string) {
    const { res, captured } = buildResponse();
    await getPostLikes(
      buildRequest({ params: { id: postId }, query: { limit: '2', ...(cursor ? { cursor } : {}) } }) as never,
      res as never,
    );
    return captured.body as {
      users: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
      totalCount: number;
    };
  }

  it('pages without repeating or skipping a liker', async () => {
    const { post, newestFirst } = await seedThreeLikes();

    const first = await page(post.id);
    expect(first.users.map((user) => user.id)).toEqual(newestFirst.slice(0, 2));
    expect(first.hasMore).toBe(true);
    expect(first.totalCount).toBe(2);
    // `"<ms>:<id>"` — the timestamp is what makes the bound chronological, and a
    // cursor that lost it would fall back to an id-only bound over a `text`
    // primary key holding two interleaved id spaces.
    expect(first.nextCursor).toMatch(/^\d+:[^:]+$/);

    const second = await page(post.id, first.nextCursor);
    expect(second.users.map((user) => user.id)).toEqual(newestFirst.slice(2));
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();

    // The union is the whole set exactly once — the property a broken keyset
    // breaks in either direction (a repeat or a hole).
    const seen = [...first.users, ...second.users].map((user) => user.id);
    expect(seen).toEqual(newestFirst);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('pages likers that share a created_at, where only the id tiebreak separates them', async () => {
    /**
     * The case a wall-clock seed cannot produce and the previous probe missed.
     *
     * `created_at` defaults to `now()`, which is `transaction_timestamp()` — so
     * three inserts in ONE transaction share the timestamp to the microsecond.
     * The `lt(createdAt, boundary)` arm of the keyset then excludes all three,
     * and the ONLY thing that advances the page is
     * `createdAt = boundary AND id < cursorId`. Drop that arm and page two comes
     * back empty while `hasMore` was true — an infinite scroll that never ends.
     */
    const post = await seedPost(scope, { oxyUserId: scope.user('author') });
    const users = ['tied-a', 'tied-b', 'tied-c'].map((label) => scope.user(label));
    await getDb().transaction(async (tx) => {
      for (const userId of users) {
        await tx.insert(likes).values({ userId, postId: post.id, value: 1 });
      }
    });
    resolveSummaries(users);

    const stamps = await getDb()
      .select({ createdAt: likes.createdAt })
      .from(likes)
      .where(eq(likes.postId, post.id));
    // The premise of the test, asserted rather than assumed: one distinct
    // timestamp across all three rows.
    expect(new Set(stamps.map((row) => row.createdAt.getTime())).size).toBe(1);

    const first = await page(post.id);
    expect(first.users).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await page(post.id, first.nextCursor);
    expect(second.users).toHaveLength(1);

    const seen = [...first.users, ...second.users].map((user) => user.id);
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual([...users].sort());
  });

  it('counts only the likes on THIS post', async () => {
    const { post } = await seedThreeLikes();
    const other = await seedPost(scope, { oxyUserId: scope.user('author') });
    await getDb()
      .insert(likes)
      .values({ userId: scope.user('elsewhere'), postId: other.id, value: 1 });

    const { res, captured } = buildResponse();
    await getPostLikes(
      buildRequest({ params: { id: post.id }, query: {} }) as never,
      res as never,
    );

    const body = captured.body as { users: Array<{ id: string }> };
    expect(body.users.map((user) => user.id)).not.toContain(scope.user('elsewhere'));
    expect(body.users).toHaveLength(3);
  });

  it('rejects a missing post id', async () => {
    const { res, captured } = buildResponse();
    await getPostLikes(buildRequest({ params: { id: '' } }) as never, res as never);
    expect(captured.status).toBe(400);
  });

  it('resets to page one on a malformed cursor rather than serving nothing', async () => {
    // A cursor is an opaque token the server minted. A malformed one is a client
    // bug or a rollback artefact, and the honest answer is the first page — not
    // an empty one, which would look like "you have reached the end".
    const { post, newestFirst } = await seedThreeLikes();

    const body = await page(post.id, 'not-a-cursor');

    expect(body.users.map((user) => user.id)).toEqual(newestFirst.slice(0, 2));
  });
});

describe('getBookmarkFolders', () => {
  async function seedBookmark(folder: string | null, userId = VIEWER): Promise<void> {
    const post = await seedPost(scope, { oxyUserId: scope.user('author') });
    await getDb().insert(bookmarks).values({ userId, postId: post.id, folder });
  }

  async function folders(userId = VIEWER): Promise<string[]> {
    const { res, captured } = buildResponse();
    await getBookmarkFolders(buildRequest({ user: { id: userId } }) as never, res as never);
    return (captured.body as { folders: string[] }).folders;
  }

  it('lists named folders and omits the unfiled (NULL) ones', async () => {
    await seedBookmark('reading');
    await seedBookmark(null);

    // `folder <> null` — the literal translation of Mongo's `$ne: null` — is
    // NULL for every row and returns `[]` here. That is a WRONG RESULT, not an
    // error, so this row assertion is the only signal there is.
    expect(await folders()).toEqual(['reading']);
  });

  it('returns each folder ONCE however many bookmarks it holds', async () => {
    await seedBookmark('reading');
    await seedBookmark('reading');
    await seedBookmark('recipes');

    expect([...(await folders())].sort()).toEqual(['reading', 'recipes']);
  });

  it('never leaks another account’s folders', async () => {
    await seedBookmark('mine');
    await seedBookmark('theirs', scope.user('someone-else'));

    expect(await folders()).toEqual(['mine']);
  });

  it('answers an unauthenticated caller with 401', async () => {
    const { res, captured } = buildResponse();
    await getBookmarkFolders(buildRequest() as never, res as never);
    expect(captured.status).toBe(401);
  });
});

describe('getSavedPosts', () => {
  /** Save a post carrying `text`, optionally into a folder. */
  async function seedSaved(text: string, folder: string | null = null): Promise<PostRecord> {
    const post = await seedPost(scope, {
      oxyUserId: scope.user('author'),
      content: { variants: [{ source: 'author', text, tag: 'en' }] },
    });
    await getDb().insert(bookmarks).values({ userId: VIEWER, postId: post.id, folder });
    return post;
  }

  async function saved(query: Record<string, string> = {}): Promise<string[]> {
    const { res, captured } = buildResponse();
    await getSavedPosts(buildRequest({ user: { id: VIEWER }, query }) as never, res as never);
    const body = captured.body as { posts: Array<{ id: string }> };
    return body.posts.map((post) => post.id);
  }

  it('returns the viewer’s saved posts and nobody else’s', async () => {
    const mine = await seedSaved('a post I saved');
    const theirs = await seedPost(scope, { oxyUserId: scope.user('author') });
    await getDb()
      .insert(bookmarks)
      .values({ userId: scope.user('someone-else'), postId: theirs.id, folder: null });

    expect(await saved()).toEqual([mine.id]);
  });

  it('filters by folder', async () => {
    const filed = await seedSaved('filed under reading', 'reading');
    await seedSaved('unfiled');

    expect(await saved({ folder: 'reading' })).toEqual([filed.id]);
  });

  it('searches the renditions, so a saved post matches by ANY language its author wrote', async () => {
    // The body lives only in `post_content_variants`, one row per language — so
    // a search that only looked at the primary rendition would miss a post the
    // viewer saved for its Spanish text.
    const post = await seedPost(scope, {
      oxyUserId: scope.user('author'),
      content: {
        variants: [
          { source: 'author', tag: 'en', text: 'a note about gardening' },
          { source: 'author', tag: 'es', text: 'una nota sobre jardinería' },
        ],
      },
    });
    await getDb().insert(bookmarks).values({ userId: VIEWER, postId: post.id, folder: null });
    await seedSaved('something else entirely');

    expect(await saved({ search: 'jardiner' })).toEqual([post.id]);
  });

  it('matches case-insensitively', async () => {
    const post = await seedSaved('A Note About Gardening');
    await seedSaved('something else entirely');

    expect(await saved({ search: 'gardening' })).toEqual([post.id]);
  });

  it('treats % in a search term as a literal wildcard-free character', async () => {
    // `%` is `ILIKE`'s multi-character wildcard, so an unescaped term spans
    // anything between its two halves.
    //
    // The term is `50%off` and NOT `100%`, and that difference is the whole
    // test. A TRAILING `%` is indistinguishable: `%100%%` and `%100\%%` match
    // exactly the same posts, so a `100%` search passes whether or not the
    // escaping exists — the first draft of this case did use `100%`, and
    // mutation-testing showed it stayed green with the escape removed. With the
    // `%` in the MIDDLE, the unescaped form also matches the "50 percent off"
    // decoy and the escaped form does not.
    const literal = await seedSaved('the sale is 50%off today');
    await seedSaved('the sale is 50 percent off today');

    expect(await saved({ search: '50%off' })).toEqual([literal.id]);
  });

  it('treats _ in a search term as a literal, not as "any single character"', async () => {
    // The wildcard that is easy to forget, because a term containing it still
    // returns SOMETHING: `a_b` unescaped matches `axb` too.
    const literal = await seedSaved('the file is named a_b today');
    await seedSaved('the file is named axb today');

    expect(await saved({ search: 'a_b' })).toEqual([literal.id]);
  });

  it('treats a backslash in a search term as a literal', async () => {
    // The escape character itself. Escaping `%` and `_` while leaving `\` alone
    // makes a term ending in a backslash escape the wildcard the code just
    // added, which is a syntax error rather than a wrong result.
    const literal = await seedSaved('the path is C:\\Users today');
    await seedSaved('no path here at all');

    expect(await saved({ search: 'C:\\Users' })).toEqual([literal.id]);
  });

  it('answers an unauthenticated caller with 401', async () => {
    const { res, captured } = buildResponse();
    await getSavedPosts(buildRequest({ query: {} }) as never, res as never);
    expect(captured.status).toBe(401);
  });

  it('returns an empty page rather than every post when the viewer has saved nothing', async () => {
    // This endpoint deliberately does NOT filter by visibility — a viewer may see
    // their own saved private posts — so the id list is the ONLY thing standing
    // between an empty bookmark table and every post in the database.
    //
    // What guarantees it is worth stating precisely, because the obvious answer
    // is wrong. It is NOT the `postIds.length === 0` short-circuit in the
    // controller: removing that leaves this test green, verified by mutation.
    // Drizzle 0.45 renders `inArray(col, [])` as the literal `false`, so the
    // query already matches nothing and the short-circuit is a saved round trip
    // rather than a correctness guard. The property under test is therefore the
    // PREDICATE, and it is pinned here because a hand-written SQL fragment — or a
    // drizzle whose empty-`IN` rendering changes — would turn "no bookmarks" into
    // "no predicate" silently.
    await seedPost(scope, { oxyUserId: scope.user('author') });

    expect(await saved()).toEqual([]);
  });
});
