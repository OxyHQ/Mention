import { Response } from 'express';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getDb } from '../db/postgres';
import { articles } from '../db/schema/articles';
import { postHydrationService } from '../services/PostHydrationService';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
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
 * **The body follows the linked post's ACL, and asks the ONE gate for it.** An
 * article is the long-form body of a post, so it is exactly as readable as that
 * post — a draft, a scheduled entry, a private or followers-only post, or one
 * whose author the viewer is restricted by, must not hand its prose to whoever
 * knows the article id. `canViewerReadPostId` is that decision and answering it
 * here with a second hand-rolled visibility check is precisely how two gates
 * drift apart; it already treats an absent viewer correctly, so anonymous reads
 * pass `''` rather than getting a bespoke branch.
 *
 * An article with NO `postId` is an unpublished draft that no post governs, so
 * the only reader is its creator.
 *
 * A refusal is a 404 with the same body as a missing row, deliberately: a 403
 * would confirm that an article with this id exists.
 */
export const getArticle = async (req: AuthRequest, res: Response) => {
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

    const viewerId = req.user?.id ?? '';
    let canRead = false;
    try {
      canRead = article.postId
        ? await postHydrationService.canViewerReadPostId(article.postId, viewerId, {
            // The docstring above names "a draft, a scheduled entry" as things
            // this gate exists to withhold — which is also, for a CHANNEL's
            // long-form piece, the state its editors most need to read it in.
            // The gate can only tell the editors from a departed writer by
            // asking Oxy who currently runs the channel, and it only asks when
            // the post is withheld and an account authored it.
            operatedAccountReader: createUserScopedOxyServices(req),
          })
        : viewerId !== '' && viewerId === article.createdBy;
    } catch (error) {
      // Fails CLOSED, the same way `ContentRoomLifecycle` treats this gate. It
      // needs the viewer's blocks from Oxy, so an Oxy outage makes the question
      // unanswerable — and an unanswerable ACL is not a yes. Refusing costs a
      // reader an article they were entitled to; allowing would publish one
      // nobody checked. This is NOT the 500 below: the ACL was reached and
      // declined to answer, which is a refusal rather than a broken route.
      logger.warn('[Articles] Refusing read: visibility check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

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
