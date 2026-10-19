/**
 * The AI translation endpoints: a published post, and a draft the author has
 * not posted yet. Both spend an Oxy inference, so both carry the translation
 * rate limiter at the route.
 */

import type { Response } from 'express';
import { loadPostRecord } from '../../db/posts/postRepository';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { safetyRequesterFor } from '../../utils/safetyRequester';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import {
  postTranslationService,
  TranslationRequestError,
  TranslationSourceChangedError,
} from '../../services/PostTranslationService';
import { TranslationOutputError } from '../../services/translationOutputGuard';
import { classifyInferenceFailure } from '../../utils/inference';
import { MAX_TEXT_LENGTH } from './composeInput';

/**
 * Map a failed translation onto a response. A {@link TranslationRequestError} is
 * the caller's fault and carries its own status; a {@link TranslationOutputError}
 * is a rejected completion (502, typed); a Kaana refusal maps onto a
 * typed status so a rate limit or data-plane outage is not reported as our 500.
 */
const respondTranslationError = async (
  res: Response,
  error: unknown,
  context: string,
): Promise<void> => {
  if (error instanceof TranslationOutputError) {
    // The model answered, but not with an acceptable translation (an echoed
    // wrapper, a dropped mention or link). Nothing was cached; asking again may
    // land on a model that gets it right.
    res
      .status(error.status)
      .json({ message: 'Translation failed. Please try again.', code: error.code });
    return;
  }
  if (error instanceof TranslationSourceChangedError) {
    // Typed so a client can tell "ask again" from a refusal.
    res.status(error.status).json({ message: error.message, code: error.code });
    return;
  }
  if (error instanceof TranslationRequestError) {
    res.status(error.status).json({ message: error.message });
    return;
  }

  const failure = await classifyInferenceFailure(error);
  if (failure === 'rate_limited') {
    logger.warn(`${context}: rate limited`, error);
    res.status(429).json({ message: 'Too many requests. Please try again later.' });
  } else if (failure === 'billing') {
    logger.warn(`${context}: translation credits issue`, error);
    res.status(502).json({ message: 'Translation service unavailable.' });
  } else if (failure === 'unavailable') {
    // Authentication, scope, policy, routing and provider refusals are all
    // failures of Mention's configured inference dependency. They are not an
    // unclassified exception in this API and must never surface as our own 500.
    logger.warn(`${context}: translation service unavailable`, error);
    res.status(503).json({ message: 'Translation service temporarily unavailable.' });
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
      // Hydrated to answer "may this reader see the post at all", not to render
      // it — the response is the translation. A note lookup would be a
      // CrowdSource round trip for a field nothing here reads.
      includeCommunityNotes: false,
      viewerId: req.user?.id,
      safetyRequester: safetyRequesterFor(req),
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

    // A stored translation changes the assessed material. Recheck the current
    // revision before serving model output; the worker will assess it again.
    const current = await loadPostRecord(post.id);
    if (
      !current ||
      !(await postHydrationService.canViewerReadPostId(post.id, req.user?.id ?? '', {
        safetyRequester: safetyRequesterFor(req),
        oxyClient: createScopedOxyClient(req),
        operatedAccountReader: createUserScopedOxyServices(req),
      }))
    ) {
      res.status(403).json({
        code: 'CONTENT_UNAVAILABLE',
        message: 'This translation is not available for this account',
      });
      return;
    }
    res.json({
      // Stored bodies keep `[mention:<id>]`; serve the rendered form, as the
      // hydrated variant is.
      translatedText: await postHydrationService.renderMentionPlaceholders(
        translated.text,
        current.mentions,
      ),
      tag: translated.tag,
      cached: translated.cached,
    });
  } catch (error) {
    await respondTranslationError(res, error, 'translatePost');
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
      res
        .status(400)
        .json({ message: `Post text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
      return;
    }

    const translated = await postTranslationService.translateDraft(text, targetLanguage, {
      delegatedUserId: userId,
    });
    res.json({ translatedText: translated.text, tag: translated.tag });
  } catch (error) {
    await respondTranslationError(res, error, 'translateDraft');
  }
};
