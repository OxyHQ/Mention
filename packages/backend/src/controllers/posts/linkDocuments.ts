import type { Response } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import {
  MAX_POST_DOCUMENTS,
  MAX_POST_DOCUMENTS_BATCH,
  type LinkPreviewResponse,
} from '@mention/shared-types';
import { loadPendingPostDocuments } from '../../services/postDocuments';
import { isOwnProfileLink, resolveClarityDocuments } from '../../utils/clarityDocuments';
import { logger } from '../../utils/logger';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { resolveViewerPrivacyAndGraph } from '../../utils/privacyHelpers';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';

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
 * `documentsPending`. See {@link loadPendingPostDocuments}.
 */
export const getPostDocuments = async (req: AuthRequest, res: Response) => {
  const parsed = postDocumentsBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request' });
  }

  try {
    const ids = [...new Set(parsed.data.ids)];
    const oxyClient = createScopedOxyClient(req);
    const viewerContext = await resolveViewerPrivacyAndGraph(req.user?.id, oxyClient);
    const response = await loadPendingPostDocuments(ids, {
      viewerId: req.user?.id,
      oxyClient,
      viewerPrivacy: viewerContext?.viewerPrivacy,
      viewerGraph: viewerContext?.viewerGraph,
      requestLanguages: requestLanguageCandidates(req),
      // The same reader `GET /posts/:id` passes: a member of a channel reads its
      // withheld posts there, so their cards must come back here too, or the
      // app clears the post's pending flag and the card never arrives.
      operatedAccountReader: createUserScopedOxyServices(req),
    });
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
