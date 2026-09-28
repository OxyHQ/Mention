import type { StoredPostContent } from '@mention/shared-types';
import { previewableUrls, resolveClarityDocuments } from '../../utils/clarityDocuments';
import { getPrimaryVariant } from '../postVariants';
import type { IngestedPost } from './types';

/**
 * Ask Oxy to resolve every previewable URL the just-stored posts carry, so a
 * reader's hydration finds a resolved preview instead of asking for one and
 * rendering nothing on this pass.
 *
 * WHY THE BATCH ENDPOINT, not the synchronous per-URL warm the create RESPONSE
 * uses (`warmClarityDocumentForText`): Oxy guards synchronous resolution with a
 * server-wide slot budget, so a bulk import taking that path would occupy a
 * shared resource on behalf of posts nobody is reading yet — and Oxy would shed
 * the overflow to its background lane anyway. The batch call resolves what it
 * already has and queues a background resolve for the rest, which is what a
 * just-stored post actually needs. Oxy owns the outbound fetch, so the
 * SSRF-safe path is its `safeFetch`; nothing is fetched here.
 *
 * BOUNDING comes from the input rather than a new limit: `extractUrls` caps
 * each body at `MAX_POST_DOCUMENTS`, URLs are de-duplicated across the whole
 * batch (a page of notes sharing one link costs one entry),
 * {@link resolveClarityDocuments} splits the set into calls of at most Clarity's
 * cap of 50 (the SDK does not; one oversized body was a 400 for the whole page),
 * and the caller's page size caps how many bodies arrive at once.
 */
export async function warmClarityDocumentsForPosts(
  posts: ReadonlyArray<IngestedPost>,
): Promise<void> {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    const text = getPrimaryVariant((post.content ?? {}) as StoredPostContent)?.text;
    if (!text) continue;
    for (const url of previewableUrls(text)) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  // Best-effort enrichment: `resolveClarityDocuments` never throws, so a
  // preview-service hiccup can never fail an ingest.
  await resolveClarityDocuments(urls);
}

/** The link-preview enrichment step (detached — see `PostEnrichmentStep`). */
export function enrichClarityDocuments(posts: ReadonlyArray<IngestedPost>): void {
  void warmClarityDocumentsForPosts(posts);
}
