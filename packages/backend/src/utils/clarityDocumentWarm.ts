import { getClarityClient } from './clarityClient';
import { extractUrls } from './extractUrls';
import { logger } from './logger';

/**
 * Ask Clarity to resolve every previewable URL in a just-published post's text
 * as a WAITING reader (`waitMs`), so the author's links queue at Clarity's
 * waiting-reader priority instead of behind background warming. Mirrors the
 * composer's bounded Clarity `resolve` request.
 *
 * The create routes start it and do NOT await it: publishing never waits on a
 * crawl. Their response reports a card that is not ready as
 * `documentsPending`, and the app asks for it (`stores/pendingDocuments.ts`).
 * Only the author's request starts it. Enriching a STORED post for every later
 * reader is a different job with a different shape (batched, detached, and run
 * by every storage route): see `services/postEnrichment/`. Do not add a new
 * enrichment here.
 */
export async function warmClarityDocumentForText(text: string | undefined): Promise<void> {
  if (!text || typeof text !== 'string') return;
  const urls = extractUrls(text);
  if (urls.length === 0) return;

  let results: PromiseSettledResult<unknown>[];
  try {
    const clarity = await getClarityClient();
    results = await Promise.allSettled(
      urls.map((url) => clarity.indexing.resolve({ urls: [url], waitMs: 8_000 })),
    );
  } catch (error) {
    // Best-effort: an unavailable service client must never fail the caller.
    logger.debug('[ClarityDocumentWarm] Failed to warm previews', {
      count: urls.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return;
  }

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.debug('[ClarityDocumentWarm] Failed to warm preview', {
        url: urls[index],
        reason: result.reason instanceof Error ? result.reason.message : 'unknown',
      });
    }
  });
}
