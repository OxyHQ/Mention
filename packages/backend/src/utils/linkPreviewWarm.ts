import { getServiceOxyClient } from './oxyHelpers';
import { extractFirstUrl } from './extractFirstUrl';
import { logger } from './logger';
import { assertSafePublicUrl } from './ssrfGuard';

const LINK_PREVIEW_WARM_TIMEOUT_MS = 3000;
const MAX_CONCURRENT_LINK_PREVIEW_WARMS = 4;
let activeLinkPreviewWarms = 0;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('link preview warm timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Ask Oxy to resolve (and cache) the first URL in post text synchronously.
 * Mirrors the composer `getLinkPreview(url, { wait: true })` warm so hydration
 * can attach a `linkPreview` on the first render (MCP/API paths included).
 */
export async function warmLinkPreviewForText(text: string | undefined): Promise<void> {
  if (!text || typeof text !== 'string') return;
  const url = extractFirstUrl(text);
  if (!url) return;
  if (activeLinkPreviewWarms >= MAX_CONCURRENT_LINK_PREVIEW_WARMS) {
    logger.debug('[LinkPreviewWarm] Skipping warm because concurrency limit is reached', { url });
    return;
  }

  activeLinkPreviewWarms += 1;
  try {
    const safety = await assertSafePublicUrl(url);
    if (!safety.ok) {
      logger.debug('[LinkPreviewWarm] Skipping unsafe preview URL', { url, reason: safety.reason });
      return;
    }

    await withTimeout(
      getServiceOxyClient().getLinkPreview(url, { wait: true }),
      LINK_PREVIEW_WARM_TIMEOUT_MS,
    );
  } catch (error) {
    logger.debug('[LinkPreviewWarm] Failed to warm preview', {
      url,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  } finally {
    activeLinkPreviewWarms = Math.max(0, activeLinkPreviewWarms - 1);
  }
}

/** Fire-and-forget warm for post-create side effects. */
export function warmLinkPreviewForTextDetached(text: string | undefined): void {
  void warmLinkPreviewForText(text);
}
