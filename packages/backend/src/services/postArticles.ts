/**
 * The long-form article a post may carry, from sanitized input to stored row.
 *
 * ONE implementation for every writer that attaches an article to a NEW post —
 * `POST /posts`, each entry of `POST /posts/thread`, and the content import
 * (`services/PostImportService.ts`). They used to spell the same two steps out
 * inline, and an excerpt bound or a failure policy changed in one of them would
 * have been missed in the others.
 *
 * ## Two steps, on purpose
 *
 * `posts.content_article_id` is part of the post's own content, so the article
 * id has to exist BEFORE the post row does, while the article row must not be
 * written until the post it belongs to succeeded — otherwise a failed post
 * creation leaves an orphan article behind. So {@link prepareArticle} mints the
 * id and builds the content reference, and {@link persistPreparedArticle} writes
 * the row once the post exists. See `db/posts/articleRepository.ts`.
 *
 * The edit path (`controllers/posts/updatePost.ts`) is deliberately not a caller:
 * it updates an existing article in place rather than creating one.
 */

import type { PostArticleContent } from '@mention/shared-types';
import { config } from '../config';
import { insertArticle, newArticleId } from '../db/posts/articleRepository';
import { logger } from '../utils/logger';

/** An article whose id is minted but whose row is not written yet. */
interface PendingArticle {
  id: string;
  createdBy: string;
  title?: string;
  body?: string;
}

/** A pending article row plus the reference the post's content carries. */
export interface PreparedArticle {
  pending: PendingArticle;
  /** What goes on `content.article`: the minted id, the title and the excerpt. */
  content: Pick<PostArticleContent, 'articleId' | 'title' | 'excerpt'>;
}

/**
 * Mint the article id and build the post's content reference for an already
 * SANITIZED article (`sanitizeArticle` in `controllers/posts/composeInput.ts`).
 *
 * Returns `null` when there is no article, so a caller can assign the result
 * without a branch of its own.
 */
export function prepareArticle(
  sanitized: { title?: string; body?: string } | undefined,
  createdBy: string,
): PreparedArticle | null {
  if (!sanitized) return null;
  const pending: PendingArticle = {
    id: newArticleId(),
    createdBy,
    title: sanitized.title || undefined,
    body: sanitized.body || undefined,
  };
  return {
    pending,
    content: {
      articleId: pending.id,
      title: sanitized.title,
      excerpt: sanitized.body
        ? sanitized.body.slice(0, config.posts.maxArticleExcerptLength)
        : undefined,
    },
  };
}

/**
 * Write the article row for a post that now exists.
 *
 * BEST-EFFORT, as it has always been at every call site: the post is already
 * committed, so a failed article write is logged under `failureMessage` and
 * never turns a published post into an error response.
 */
export async function persistPreparedArticle(
  prepared: PreparedArticle | null,
  postId: string,
  failureMessage: string,
): Promise<void> {
  if (!prepared) return;
  try {
    await insertArticle({ ...prepared.pending, postId });
  } catch (articleError) {
    logger.error(failureMessage, articleError);
  }
}
