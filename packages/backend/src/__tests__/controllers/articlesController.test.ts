/**
 * `GET /articles/:id` against real rows.
 *
 * Small file, two real changes to hold down:
 *
 *  - **The id guard is gone and nothing replaced it.** `findById` threw a
 *    Mongoose `CastError` for anything that was not 24-char hex, and the catch
 *    turned that into a 500. A `text` primary key matches no row, so a malformed
 *    id and a deleted article now give the same honest 404.
 *  - **An absent optional is OMITTED, not `null`.** Mongoose left `postId`,
 *    `title` and `body` `undefined`, which `JSON.stringify` drops; drizzle hands
 *    back `null`, which it would not.
 *  - **The body follows the linked post's ACL.** The route used to hand any
 *    article's prose to whoever knew its id, so the refusal cases each write a
 *    post the reader must NOT see and assert a 404 carrying the missing-row
 *    body. Two POSITIVE CONTROLS keep them from passing against a route that
 *    simply refuses everything: the public/published article is served, and an
 *    unlinked draft is served to its creator.
 *
 *    The refusals are asserted ANONYMOUSLY on purpose. With a viewer present
 *    the gate needs that viewer's blocks from Oxy, which no test here can
 *    reach, and the controller fails closed on an unanswerable ACL — so a
 *    viewer-present refusal would pass whether or not the ACL was consulted,
 *    and would measure nothing. The creator case is the viewer-present control
 *    that still means something: an unlinked article has no post, so it is
 *    decided without asking Oxy at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

import { getArticle } from '../../controllers/articles.controller';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { articles } from '../../db/schema/articles';
import { posts } from '../../db/schema/posts';

let db: Database;
const createdArticleIds: string[] = [];
const createdPostIds: string[] = [];

interface CapturedResponse {
  status: number;
  body: unknown;
}

async function call(id: string, viewerId?: string): Promise<CapturedResponse> {
  const captured: CapturedResponse = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  await getArticle(
    { params: { id }, user: viewerId ? { id: viewerId } : undefined } as never,
    res as never,
  );
  return captured;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdArticleIds.length > 0) {
    await db.delete(articles).where(inArray(articles.id, createdArticleIds.splice(0)));
  }
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPostIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('getArticle', () => {
  it('returns the article with its post link and timestamps', async () => {
    const author = `article-author-${randomUUID()}`;
    const [post] = await db.insert(posts).values({ oxyUserId: author }).returning({ id: posts.id });
    createdPostIds.push(post.id);
    const [article] = await db
      .insert(articles)
      .values({ postId: post.id, createdBy: author, title: 'A title', body: 'A body' })
      .returning({ id: articles.id });
    createdArticleIds.push(article.id);

    const res = await call(article.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: article.id,
      postId: post.id,
      title: 'A title',
      body: 'A body',
      createdBy: author,
    });
    expect((res.body as { createdAt: Date }).createdAt).toBeInstanceOf(Date);
    expect((res.body as { updatedAt: Date }).updatedAt).toBeInstanceOf(Date);
  });

  it('OMITS an absent optional rather than sending null', async () => {
    const author = `article-author-${randomUUID()}`;
    const [article] = await db
      .insert(articles)
      .values({ createdBy: author })
      .returning({ id: articles.id });
    createdArticleIds.push(article.id);

    // An article with no post is a draft nothing governs, so its creator is the
    // reader — this also keeps the shape assertions below on a 200 body.
    const res = await call(article.id, author);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('postId');
    expect(res.body).not.toHaveProperty('title');
    expect(res.body).not.toHaveProperty('body');
    expect(JSON.parse(JSON.stringify(res.body))).not.toHaveProperty('title');
  });

  it('refuses an unlinked draft to everyone but its creator', async () => {
    const author = `article-author-${randomUUID()}`;
    const [article] = await db
      .insert(articles)
      .values({ createdBy: author, body: 'unpublished prose' })
      .returning({ id: articles.id });
    createdArticleIds.push(article.id);

    for (const viewer of [undefined, `stranger-${randomUUID()}`]) {
      const res = await call(article.id, viewer);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: 'Article not found' });
    }
  });

  it.each([
    ['a private post', { visibility: 'private' as const, status: 'published' as const }],
    ['a followers-only post', { visibility: 'followers_only' as const, status: 'published' as const }],
    ['a draft post', { visibility: 'public' as const, status: 'draft' as const }],
    ['a scheduled post', { visibility: 'public' as const, status: 'scheduled' as const }],
  ])('withholds the body of an article on %s, and still serves its author', async (_label, row) => {
    const author = `article-author-${randomUUID()}`;
    const [post] = await db
      .insert(posts)
      .values({ oxyUserId: author, ...row })
      .returning({ id: posts.id });
    createdPostIds.push(post.id);
    const [article] = await db
      .insert(articles)
      .values({ postId: post.id, createdBy: author, body: 'restricted prose' })
      .returning({ id: articles.id });
    createdArticleIds.push(article.id);

    const refused = await call(article.id);
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ message: 'Article not found' });
  });

  it.each([
    ['a uuid v7 that names nothing', uuidv7()],
    ['a 24-hex id that names nothing', randomUUID().replace(/-/g, '').slice(0, 24)],
    ['a string that is not an id at all', 'not-an-id'],
  ])('404s %s, never 500', async (_label, id) => {
    const res = await call(id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Article not found' });
  });
});
