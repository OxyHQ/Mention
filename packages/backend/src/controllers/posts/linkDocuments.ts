import { Response } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import {
  MAX_POST_DOCUMENTS,
  MAX_POST_DOCUMENTS_BATCH,
  type LinkPreviewResponse,
  type PostDocumentsResponse,
} from '@mention/shared-types';
import { loadPostRecords } from '../../db/posts/postRepository';
import { postHydrationService } from '../../services/PostHydrationService';
import { isOwnProfileLink, resolveClarityDocuments } from '../../utils/clarityDocuments';
import { logger } from '../../utils/logger';
import { createScopedOxyClient } from '../../utils/oxyHelpers';
import { resolveViewerPrivacyAndGraph } from '../../utils/privacyHelpers';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';

/**
 * How long a follow-up may hold Clarity open for links it is still indexing.
 * These calls are off the render path — the post is already on screen without
 * its card — so waiting here costs the reader nothing, unlike on a feed read
 * (issue #1140).
 */
const FOLLOW_UP_WAIT_MS = 3_000;

/** The composer's wait: the author is looking at the card slot while they type. */
const COMPOSER_WAIT_MS = 8_000;

const postDocumentsBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_POST_DOCUMENTS_BATCH),
});

const linkPreviewBody = z.object({
  urls: z.array(z.string().min(1).max(2048)).min(1).max(MAX_POST_DOCUMENTS),
});

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * `POST /posts/documents` — the link cards of posts whose first read reported
 * `documentsPending`.
 *
 * The posts go through the same hydration as `GET /posts/:id`, so this answers
 * for exactly the posts this viewer may read, in the language variant they are
 * served, and a post they may not read is simply absent from the answer. Only
 * the cards are returned; the app already has the rest of each post.
 */
export const getPostDocuments = async (req: AuthRequest, res: Response) => {
  const parsed = postDocumentsBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request' });
  }

  try {
    const ids = [...new Set(parsed.data.ids)];
    const oxyClient = createScopedOxyClient(req);
    const [records, viewerContext] = await Promise.all([
      loadPostRecords(ids),
      resolveViewerPrivacyAndGraph(req.user?.id, oxyClient),
    ]);

    const response: PostDocumentsResponse = { posts: {} };
    if (records.length === 0) return res.json(response);

    const hydrated = await postHydrationService.hydratePosts(records, {
      viewerId: req.user?.id,
      oxyClient,
      viewerPrivacy: viewerContext?.viewerPrivacy,
      viewerGraph: viewerContext?.viewerGraph,
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 0,
      includeLinkMetadata: true,
      linkMetadataWaitMs: FOLLOW_UP_WAIT_MS,
    });

    const requested = new Set(ids);
    for (const post of hydrated) {
      if (!requested.has(post.id)) continue;
      response.posts[post.id] = {
        documents: post.documents ?? [],
        ...(post.documentsPending ? { documentsPending: true } : {}),
      };
    }
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post documents', error);
    return res.status(500).json({ message: 'Error fetching post documents' });
  }
};

/**
 * `POST /posts/link-previews` — the composer's link cards.
 *
 * The app never calls Clarity itself: it sends the links it found in the draft
 * here, and this backend resolves them with its own service credentials. Links
 * to a profile on this instance get no card, as in hydration, so the composer
 * never shows an attachment the published post will not carry.
 */
export const resolveLinkPreviews = async (req: AuthRequest, res: Response) => {
  const parsed = linkPreviewBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request' });
  }

  const urls = [...new Set(parsed.data.urls)].filter(
    (url) => isHttpUrl(url) && !isOwnProfileLink(url),
  );
  const resolved = await resolveClarityDocuments(urls, { waitMs: COMPOSER_WAIT_MS });

  const response: LinkPreviewResponse = {
    previews: urls.flatMap((url) => {
      const document = resolved.documents.get(url);
      return document ? [{ url, document }] : [];
    }),
    pending: urls.filter((url) => resolved.pending.has(url)),
  };
  return res.json(response);
};
