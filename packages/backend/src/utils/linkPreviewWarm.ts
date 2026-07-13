import { getServiceOxyClient } from './oxyHelpers';
import { extractUrls } from './extractUrls';
import { logger } from './logger';

/**
 * Ask Oxy to resolve (and cache) every previewable URL in post text
 * synchronously. Mirrors the composer `getLinkPreview(url, { wait: true })` warm
 * so hydration can attach the post's `linkPreviews` on the first render
 * (MCP/API paths included).
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

/** Fire-and-forget warm for post-create side effects. */
export function warmLinkPreviewForTextDetached(text: string | undefined): void {
  void warmLinkPreviewForText(text);
}
