import { getServiceOxyClient } from './oxyHelpers';
import { extractFirstUrl } from './extractFirstUrl';
import { logger } from './logger';

/**
 * Ask Oxy to resolve (and cache) the first URL in post text synchronously.
 * Mirrors the composer `getLinkPreview(url, { wait: true })` warm so hydration
 * can attach a `linkPreview` on the first render (MCP/API paths included).
 */
export async function warmLinkPreviewForText(text: string | undefined): Promise<void> {
  if (!text || typeof text !== 'string') return;
  const url = extractFirstUrl(text);
  if (!url) return;
  try {
    await getServiceOxyClient().getLinkPreview(url, { wait: true });
  } catch (error) {
    logger.debug('[LinkPreviewWarm] Failed to warm preview', {
      url,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/** Fire-and-forget warm for post-create side effects. */
export function warmLinkPreviewForTextDetached(text: string | undefined): void {
  void warmLinkPreviewForText(text);
}
