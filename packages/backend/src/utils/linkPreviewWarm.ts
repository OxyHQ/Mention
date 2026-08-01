import { getServiceOxyClient } from './oxyHelpers';
import { extractUrls } from './extractUrls';
import { logger } from './logger';

/**
 * Ask Oxy to resolve every previewable URL in post text SYNCHRONOUSLY, so the
 * response being built right now can carry the post's `linkPreviews`. Mirrors
 * the composer's `getLinkPreview(url, { wait: true })`.
 *
 * This is response completeness, NOT post-ingest enrichment — the caller awaits
 * it before hydrating its own reply, and only the author of that request
 * benefits. Enriching a STORED post for every later reader is a different job
 * with a different shape (batched, detached, and run by every storage route):
 * see `services/postEnrichment/`. Do not add a new enrichment here.
 */
export async function warmLinkPreviewForText(text: string | undefined): Promise<void> {
  if (!text || typeof text !== 'string') return;
  const urls = extractUrls(text);
  if (urls.length === 0) return;

  let results: PromiseSettledResult<unknown>[];
  try {
    const oxy = getServiceOxyClient();
    results = await Promise.allSettled(urls.map((url) => oxy.getLinkPreview(url, { wait: true })));
  } catch (error) {
    // Best-effort: an unavailable service client must never fail the caller.
    logger.debug('[LinkPreviewWarm] Failed to warm previews', {
      count: urls.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return;
  }

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.debug('[LinkPreviewWarm] Failed to warm preview', {
        url: urls[index],
        reason: result.reason instanceof Error ? result.reason.message : 'unknown',
      });
    }
  });
}
