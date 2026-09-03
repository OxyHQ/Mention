/**
 * The AI translation endpoints: a published post, and a draft the author has
 * not posted yet. Both spend an Oxy inference, so both carry the translation
 * rate limiter at the route.
 */

import { Response } from 'express';
import { loadPostRecord } from '../../db/posts/postRepository';
import { OxyInferenceError } from '@oxyhq/core';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { postTranslationService, TranslationRequestError } from '../../services/PostTranslationService';
import { MAX_TEXT_LENGTH } from './composeInput';

/**
 * Map a failed translation onto a response. A {@link TranslationRequestError} is
 * the caller's fault and carries its own status; an Oxy edge refusal carries a
 * typed status so a rate limit or data-plane outage is not reported as our 500.
 */
const respondTranslationError = (res: Response, error: unknown, context: string): void => {
  if (error instanceof TranslationRequestError) {
    res.status(error.status).json({ message: error.message });
    return;
  }

  const edgeStatus = error instanceof OxyInferenceError ? error.status : 0;

  if (edgeStatus === 429) {
    logger.warn(`${context}: rate limited`, error);
    res.status(429).json({ message: 'Too many requests. Please try again later.' });
  } else if (edgeStatus === 503 || edgeStatus === 502) {
    logger.warn(`${context}: translation service unavailable`, error);
    res.status(503).json({ message: 'Translation service temporarily unavailable.' });
  } else if (edgeStatus === 402) {
    logger.warn(`${context}: translation credits issue`, error);
    res.status(502).json({ message: 'Translation service unavailable.' });
  } else {
    logger.error(`${context}: translation failed`, error);
    res.status(500).json({ message: 'Translation failed' });
  }
};

/**
 * Translate a post on demand and cache the result ON the post, as a
 * `source: 'machine'` language variant — the same array the author's own variants
 * live in, so the next reader whose language ladder lands on it is served straight
 * from hydration. Any language is allowed (the machine cache is uncapped), and an
 * AUTHOR variant for the requested language short-circuits the model entirely.
 *
 * Visibility is enforced through hydration (the single ACL authority): a post this
 * viewer cannot see is a 404, exactly as it is on the read path.
 */
export const translatePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { targetLanguage, force } = req.body;

    const post = await loadPostRecord(String(id));
    if (!post) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const visiblePosts = await postHydrationService.hydratePosts([post], {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 0,
      includeLinkMetadata: false,
      includeFullArticleBody: false,
      includeFullMetadata: false,
      // Loaded by id with no status filter, so a channel's operators must be
      // able to translate a story before it publishes — which is when a
      // translation is worth anything.
      operatedAccountReader: createUserScopedOxyServices(req),
    });
    if (visiblePosts.length === 0) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const translated = await postTranslationService.translatePost(
      post.id,
      post.content,
      targetLanguage,
      { force: force === true, delegatedUserId: req.user?.id },
    );

    res.json({
      translatedText: translated.text,
      tag: translated.tag,
      cached: translated.cached,
    });
  } catch (error) {
    respondTranslationError(res, error, 'translatePost');
  }
};

/**
 * Translate a DRAFT body the composer is holding — there is no post yet, so
 * nothing is persisted. The result pre-fills a language tab as an editable draft;
 * what the author approves is what gets saved, as an AUTHOR variant.
 */
export const translateDraft = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const { text, targetLanguage } = req.body;
    if (typeof text !== 'string') {
      res.status(400).json({ message: 'text is required' });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ message: `Post text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
      return;
    }

    const translated = await postTranslationService.translateDraft(text, targetLanguage, {
      delegatedUserId: userId,
    });
    res.json({ translatedText: translated.text, tag: translated.tag });
  } catch (error) {
    respondTranslationError(res, error, 'translateDraft');
  }
};
