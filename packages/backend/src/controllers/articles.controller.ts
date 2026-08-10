import { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { articles } from '../db/schema/articles';
import { postHydrationService } from '../services/PostHydrationService';
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
 */
export const getArticle = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [article] = await getDb()
      .select()
      .from(articles)
      .where(eq(articles.id, String(id)))
      .limit(1);

    if (!article) {
      return res.status(404).json({ message: 'Article not found' });
    }

    const viewerId = req.user?.id;
    const canRead = article.postId
      ? await postHydrationService.canViewerReadPostId(article.postId, viewerId)
      : viewerId === article.createdBy;

    // Do not reveal whether an inaccessible article id exists. An unlinked
    // article is a draft and is readable only by its creator; linked articles
    // inherit the canonical post ACL (status, visibility, profile and graph).
    if (!canRead) {
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
