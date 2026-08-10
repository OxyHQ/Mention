import { Request, Response } from 'express';
import { and, eq, or } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { articles } from '../db/schema/articles';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';

/**
 * Read one long-form article body.
 *
 * Two things changed with the store, and neither may reach the client.
 *
 * **The id guard is gone, and nothing replaced it.** `ArticleModel.findById(id)`
 * threw a Mongoose `CastError` for anything that was not 24-char hex, which
 * landed in the catch below and answered 500. A `text` primary key simply
 * matches no row, so a malformed id and a deleted article now give the same
 * honest 404 — there is nothing here to widen, and reaching for `isLiveEntityId`
 * would only re-introduce a precondition that fails a perfectly valid id shape
 * nobody has taught it about yet.
 *
 * **An absent optional is OMITTED, not `null`.** Mongoose left `postId`, `title`
 * and `body` `undefined` when unset, which `JSON.stringify` drops; drizzle hands
 * back `null`, which it would not. Same rule as `LabelService.serializeLabeler`.
 *
 * This route is read-only. `Article`'s `trim: true` on `title`/`body` is
 * application behaviour with no Postgres counterpart, but it belongs to the
 * WRITE path (`controllers/posts.controller.ts`), not here.
 *
 * An article is readable when its linked post is public and published, or by
 * its author. Keeping that predicate in the query makes inaccessible and
 * nonexistent ids indistinguishable and also protects orphan draft articles.
 */
export const getArticle = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const viewerId = req.user?.id;
    const publiclyReadable = and(
      eq(posts.status, 'published'),
      eq(posts.visibility, 'public'),
    );
    const canRead = viewerId
      ? or(publiclyReadable, eq(articles.createdBy, viewerId))
      : publiclyReadable;
    const [article] = await getDb()
      .select({
        id: articles.id,
        postId: articles.postId,
        title: articles.title,
        body: articles.body,
        createdBy: articles.createdBy,
        createdAt: articles.createdAt,
        updatedAt: articles.updatedAt,
      })
      .from(articles)
      .leftJoin(posts, eq(posts.id, articles.postId))
      .where(and(eq(articles.id, String(id)), canRead))
      .limit(1);

    if (!article) {
      return res.status(404).json({ message: 'Article not found' });
    }

    return res.json({
      id: article.id,
      ...(article.postId === null ? {} : { postId: article.postId }),
      ...(article.title === null ? {} : { title: article.title }),
      ...(article.body === null ? {} : { body: article.body }),
      createdBy: article.createdBy,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    });
  } catch (error) {
    logger.error('[Articles] Error fetching article:', error);
    return res.status(500).json({ message: 'Error fetching article', error });
  }
};
