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
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

import { getArticle } from '../../controllers/articles.controller';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '@oxyhq/db';
import { articles } from '../../db/schema/articles';
import { posts } from '../../db/schema/posts';

let db: Database;
const createdArticleIds: string[] = [];
const createdPostIds: string[] = [];

interface CapturedResponse {
  status: number;
  body: unknown;
}

async function call(id: string): Promise<CapturedResponse> {
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
  await getArticle({ params: { id } } as never, res as never);
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

    const res = await call(article.id);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('postId');
    expect(res.body).not.toHaveProperty('title');
    expect(res.body).not.toHaveProperty('body');
    expect(JSON.parse(JSON.stringify(res.body))).not.toHaveProperty('title');
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
