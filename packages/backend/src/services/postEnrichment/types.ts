import type { StoredPostContent } from '@mention/shared-types';

/**
 * The post shape enrichment needs, and the only thing a creator must be able to
 * supply.
 *
 * Deliberately narrower than `PostRecord`: the contract is the intersection
 * both storage routes genuinely have — the stored id and the stored content —
 * so a step can never come to depend on a field only one of them assembles.
 */
export interface IngestedPost {
  id: string;
  content?: StoredPostContent | null;
}

/**
 * One post-ingest enrichment.
 *
 * Batch-shaped because one of the two storage routes is a bulk import: the
 * outbox backfill stores a whole page of notes at once, and a step that can
 * dedupe or coalesce across that page (link previews do both) needs to see the
 * page rather than one post at a time. A single-post caller passes one element.
 *
 * Returns void and must never throw: an enrichment is not allowed to delay,
 * fail, or roll back the ingestion of the post it enriches.
 */
export type PostEnrichmentStep = (posts: ReadonlyArray<IngestedPost>) => void;
