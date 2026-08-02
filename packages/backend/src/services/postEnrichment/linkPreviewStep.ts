import type { StoredPostContent } from '@mention/shared-types';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { extractUrls } from '../../utils/extractUrls';
import { getPrimaryVariant } from '../postVariants';
import { logger } from '../../utils/logger';
import type { IngestedPost } from './types';

/**
 * Ask Oxy to resolve every previewable URL the just-stored posts carry, so a
 * reader's hydration finds a resolved preview instead of asking for one and
 * rendering nothing on this pass.
 *
 * WHY THE BATCH ENDPOINT, not the synchronous per-URL warm the create RESPONSE
 * uses (`warmLinkPreviewForText`): Oxy guards synchronous resolution with a
 * server-wide slot budget, so a bulk import taking that path would occupy a
 * shared resource on behalf of posts nobody is reading yet — and Oxy would shed
 * the overflow to its background lane anyway. The batch call resolves what it
 * already has and queues a background resolve for the rest, which is what a
 * just-stored post actually needs. Oxy owns the outbound fetch, so the
 * SSRF-safe path is its `safeFetch`; nothing is fetched here.
 *
 * BOUNDING comes from the input rather than a new limit: `extractUrls` caps
 * each body at `MAX_POST_LINK_PREVIEWS`, URLs are de-duplicated across the whole
 * batch (a page of notes sharing one link costs one entry), the SDK chunks at
 * its server-side cap of 50, and the caller's page size caps how many bodies
 * arrive at once.
 */
export async function warmLinkPreviewsForPosts(
  posts: ReadonlyArray<IngestedPost>,
): Promise<void> {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    const text = getPrimaryVariant((post.content ?? {}) as StoredPostContent)?.text;
    if (!text) continue;
    for (const url of extractUrls(text)) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  if (urls.length === 0) return;

  try {
    await getServiceOxyClient().getLinkPreviews(urls);
  } catch (error) {
    // Best-effort enrichment: a preview-service hiccup must never fail an ingest.
    logger.debug('[PostEnrichment] Failed to warm link previews', {
      count: urls.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/** The link-preview enrichment step (detached — see `PostEnrichmentStep`). */
export function enrichLinkPreviews(posts: ReadonlyArray<IngestedPost>): void {
  void warmLinkPreviewsForPosts(posts);
}
