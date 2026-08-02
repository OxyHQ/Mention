/**
 * `articles` — the long-form body of a post.
 *
 * The READ side (`controllers/articles.controller.ts`) was ported first, which
 * left the write side in Mongo: every article written after that point was
 * stored somewhere `GET /articles/:id` does not look, and the route answered a
 * perfectly ordinary 404 for it. This module is the other half.
 *
 * ## The id is minted before the row exists, on purpose
 *
 * `posts.content_article_id` is written as part of the post's own content
 * document, so the article's id has to be known BEFORE the post row is created,
 * while the row itself must not be written until the post it belongs to
 * succeeded — otherwise a failed post creation leaves an orphan article behind.
 * Mongoose got this for free (`new Model()` mints `_id` client-side and `save()`
 * is a separate act); {@link newArticleId} plus a later {@link insertArticle} is
 * the same two-step, spelled out.
 *
 * ## `trim` has no Postgres counterpart
 *
 * `models/Article.ts` declared `trim: true` on `title` and `body`. That is
 * application behaviour, and it stays in the write path here rather than being
 * dropped on the floor or turned into a CHECK that would reject historical rows.
 */

import { eq, inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { articles, ARTICLE_TITLE_MAX_LENGTH } from '../schema/articles';
import { uuidv7 } from '../schema/columns';

/** One stored article. Absent optionals are `undefined`, never `null`. */
export interface ArticleRecord {
  id: string;
  postId?: string;
  createdBy: string;
  title?: string;
  body?: string;
}

/** The fields a caller may write. */
export interface ArticleContent {
  title?: string;
  body?: string;
}

/**
 * Apply what the Mongoose schema applied on the way in: trim, and drop an empty
 * string to absent so an unset field is `null` rather than `''`.
 */
function normalize(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Enforce the `maxlength` the Mongoose schema declared on `title`. */
function normalizeTitle(value: string | undefined): string | null {
  const trimmed = normalize(value);
  if (trimmed === null) return null;
  return trimmed.slice(0, ARTICLE_TITLE_MAX_LENGTH);
}

function toRecord(row: typeof articles.$inferSelect): ArticleRecord {
  return {
    id: row.id,
    postId: row.postId ?? undefined,
    createdBy: row.createdBy,
    title: row.title ?? undefined,
    body: row.body ?? undefined,
  };
}

/**
 * Mint an article id without writing anything.
 *
 * The post's content document has to carry this id, and the post is written
 * first — see the module comment.
 */
export function newArticleId(): string {
  return uuidv7();
}

/** Write a new article row. */
export async function insertArticle(
  article: { id: string; postId?: string; createdBy: string } & ArticleContent,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(articles).values({
    id: article.id,
    postId: article.postId ?? null,
    createdBy: article.createdBy,
    title: normalizeTitle(article.title),
    body: normalize(article.body),
  });
}

/** One article by id, or `undefined` when there is no such row. */
export async function findArticleById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ArticleRecord | undefined> {
  const [row] = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
  return row ? toRecord(row) : undefined;
}

/**
 * Update an existing article's body and re-anchor it to `postId`.
 *
 * A field the caller did not name is LEFT ALONE — `undefined` means "not
 * supplied", which is what the edit route's `sanitizedArticle.title !==
 * undefined` branches already distinguish. Passing an empty string clears it.
 *
 * @returns Whether a row was updated. `false` means the article is gone, which
 *   the caller must not read as "updated nothing to do".
 */
export async function updateArticle(
  id: string,
  postId: string,
  content: ArticleContent,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(articles)
    .set({
      postId,
      ...(content.title === undefined ? {} : { title: normalizeTitle(content.title) }),
      ...(content.body === undefined ? {} : { body: normalize(content.body) }),
    })
    .where(eq(articles.id, id))
    .returning({ id: articles.id });
  return updated.length > 0;
}

/** Remove articles by id. Returns how many rows were removed. */
export async function deleteArticles(
  ids: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const removed = await db
    .delete(articles)
    .where(inArray(articles.id, [...ids]))
    .returning({ id: articles.id });
  return removed.length;
}
