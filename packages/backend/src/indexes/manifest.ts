import type { IndexDescription } from 'mongodb';

/**
 * Versioned index manifest for the Post hot paths.
 *
 * Production disables Mongoose auto-indexing, so these definitions are also
 * consumed by a lease-protected migration. Existing indexes are intentionally
 * left in place: removal requires a separate telemetry-backed migration after
 * at least 14 days of `$indexStats` evidence.
 */
export const POST_HOT_PATH_INDEX_MANIFEST_VERSION = 1 as const;

export const POST_HOT_PATH_INDEXES = [
  {
    name: 'post_public_chrono_v1',
    key: { visibility: 1, status: 1, createdAt: -1, _id: -1 },
  },
  {
    name: 'post_author_chrono_v1',
    key: {
      'authorship.oxyUserId': 1,
      'authorship.status': 1,
      visibility: 1,
      status: 1,
      createdAt: -1,
      _id: -1,
    },
  },
  {
    name: 'post_replies_chrono_v1',
    key: {
      parentPostId: 1,
      visibility: 1,
      status: 1,
      createdAt: -1,
      _id: -1,
    },
  },
  {
    name: 'post_links_chrono_v1',
    key: {
      hasLinks: 1,
      visibility: 1,
      status: 1,
      createdAt: -1,
      _id: -1,
    },
  },
] as const satisfies readonly IndexDescription[];

/**
 * MongoDB permits only one text index per collection. Keep its complete
 * functional definition separate from the btree hot-path list so the migration
 * can inspect/replace the retired `content.text_text` index deliberately.
 */
export const POST_TEXT_SEARCH_INDEX = {
  name: 'content.variants.text_text',
  key: { 'content.variants.text': 'text' },
  default_language: 'english',
  language_override: 'textSearchLanguage',
  weights: { 'content.variants.text': 1 },
} as const satisfies IndexDescription;

/**
 * The MTN append algorithm relies on both constraints as concurrency
 * backstops. In production Mongoose auto-indexing is disabled, so declaring
 * them only on the schema is insufficient.
 */
export const MTN_RECORD_ID_INDEX = {
  name: 'recordId_1',
  key: { recordId: 1 },
  unique: true,
  partialFilterExpression: { recordId: { $type: 'string' } },
} as const satisfies IndexDescription;

export const MTN_SEQUENCE_INDEX = {
  name: 'oxyUserId_1_seq_1',
  key: { oxyUserId: 1, seq: 1 },
  unique: true,
  partialFilterExpression: { seq: { $type: 'number' } },
} as const satisfies IndexDescription;

export const MTN_CHAIN_INTEGRITY_INDEXES = [
  MTN_RECORD_ID_INDEX,
  MTN_SEQUENCE_INDEX,
] as const satisfies readonly IndexDescription[];

/**
 * One append-only MTN record per durable event and chain subject. The event id
 * is deliberately independent from the logical record key: like -> tombstone
 * -> re-like transitions keep their normal rkey while each outbox revision gets
 * its own idempotency identity.
 */
export const MTN_EVENT_IDEMPOTENCY_INDEX = {
  name: 'mtn_event_idempotency_unique_v1',
  key: { oxyUserId: 1, idempotencyKey: 1 },
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: 'string' } },
} as const satisfies IndexDescription;
