import type { StoredPostContent } from '@mention/shared-types';

/**
 * The post shape enrichment needs, and the only thing a creator must be able to
 * supply.
 *
 * Deliberately narrower than `IPost`: the ActivityPub outbox backfill's raw
 * insert documents are not Mongoose documents and never will be (it writes
 * through `Post.collection.insertMany` on purpose), so the contract is the
 * intersection both storage routes genuinely have — the stored id and the
 * stored content.
 */
export interface IngestedPost {
  _id: unknown;
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
