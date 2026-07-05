/**
 * Atproto bridge repo READ service (Phase C4).
 *
 * Reads a local user's MTN signed-record chain (`MentionSignedRecord`, the SAME
 * store the MTN dual-write fills) and projects the CURRENT materialized state of
 * a collection into atproto records, so a Bluesky AppView can read the user via
 * `com.atproto.repo.listRecords` / `getRecord` / `describeRepo` /
 * `com.atproto.sync.getLatestCommit`.
 *
 * Materialization rules (mirror the MTN materializer's read semantics, applied
 * here PURELY at read time — no writes):
 *  - LAST-WRITER-WINS per `(collection, rkey)`: the newest verified record for a
 *    key is the live one (an edit supersedes an older version).
 *  - TOMBSTONES remove a key: an `app.mention.feed.tombstone` whose `subject`
 *    points at a key in this collection drops that key from the view.
 *  - PRIVATE collections (`app.mention.feed.bookmark`) are NEVER served.
 *  - Only `verified` rows are read.
 *
 * Everything here reads Mention's OWN Mongo (the local chain). No node fetch, no
 * remote I/O — the read path never touches a node (the MTN fault-isolation
 * invariant). The translation to `app.bsky.feed.*` is owned by `recordTranslator`.
 */

import {
  MtnUri,
  MENTION_TOMBSTONE_COLLECTION,
  mentionPostRecordSchema,
  mentionLikeRecordSchema,
  mentionRepostRecordSchema,
  mentionTombstoneRecordSchema,
  PostVisibility,
} from '@mention/shared-types';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import MentionSignedRecord from '../../../models/MentionSignedRecord';
import { Post } from '../../../models/Post';
import { buildUserDid } from '../../../services/mtn/mentionDid';
import { logger } from '../../../utils/logger';
import {
  BSKY_TO_MTN_COLLECTION,
  type AtprotoRecordValue,
  translatePostRecord,
  translateLikeRecord,
  translateRepostRecord,
} from './recordTranslator';
import {
  BSKY_POST_COLLECTION,
  BSKY_LIKE_COLLECTION,
  BSKY_REPOST_COLLECTION,
  LIST_RECORDS_DEFAULT_LIMIT,
  LIST_RECORDS_MAX_LIMIT,
} from './constants';

/** A single materialized, atproto-translated record in a `listRecords` page. */
export interface BridgeRecord {
  /** The record's AT-URI (`at://<did>/<bsky collection>/<rkey>`). */
  uri: string;
  /** The record's placeholder CID (deterministic; not a real MST CID — flagged). */
  cid: string;
  /** The translated `app.bsky.feed.*` record value. */
  value: AtprotoRecordValue;
  /** The MTN record key (rkey) — the cursor unit for pagination. */
  rkey: string;
  /** The record's createdAt (ISO), used to order the page newest-first. */
  createdAt: string;
}

/** A `listRecords` page: the records plus the opaque next cursor. */
export interface ListRecordsPage {
  records: BridgeRecord[];
  cursor?: string;
}

/** Clamp a caller-supplied `listRecords` limit into the atproto-conventional band. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return LIST_RECORDS_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit), LIST_RECORDS_MAX_LIMIT));
}

/** The denormalized row shape this service reads from the ledger. */
interface LedgerRow {
  rkey?: string;
  nsid?: string;
  recordId?: string;
  createdAt: Date;
  envelope: SignedRecordEnvelope;
}

/**
 * Read the verified rows needed to materialize ONE feed collection, newest-first:
 * the requested `mtnCollection` itself PLUS the tombstone collection (a tombstone
 * lives in its own collection but removes a key in the feed collection, so it must
 * be read alongside). Scoping the `$in` to just these two — instead of every feed
 * collection — avoids loading 4× the rows the materializer will keep. Bounded by
 * the per-user chain size; the MTN chain is a single signer's append-only log, so
 * this is a per-user scan, not a global one. An optional `rkey` narrows the read
 * to a single key (the `getRecord` path) — the tombstone collection is still read
 * in full because a deletion may target that key.
 */
async function readLiveRows(
  oxyUserId: string,
  mtnCollection: string,
  rkey?: string,
): Promise<LedgerRow[]> {
  // The feed-collection branch is the only one narrowed by rkey; tombstones are
  // always read in full (they delete by `subject`, not by their own rkey).
  const feedClause: Record<string, unknown> = { nsid: mtnCollection };
  if (typeof rkey === 'string' && rkey.length > 0) feedClause.rkey = rkey;

  return MentionSignedRecord.find({
    oxyUserId,
    verified: true,
    $or: [feedClause, { nsid: MENTION_TOMBSTONE_COLLECTION }],
  })
    .sort({ createdAt: -1, seq: -1 })
    .lean<LedgerRow[]>();
}

/** Collect the set of MTN record keys (`collection/rkey`) deleted by tombstones. */
function collectTombstonedKeys(rows: LedgerRow[]): Set<string> {
  const deleted = new Set<string>();
  for (const row of rows) {
    if (row.nsid !== MENTION_TOMBSTONE_COLLECTION) continue;
    const parsed = mentionTombstoneRecordSchema.safeParse(row.envelope.record);
    if (!parsed.success) continue;
    if (!MtnUri.isValid(parsed.data.subject)) continue;
    const subject = MtnUri.parse(parsed.data.subject);
    deleted.add(`${subject.collection}/${subject.rkey}`);
  }
  return deleted;
}

/**
 * Translate one MTN ledger row into an atproto record value for the requested
 * bsky collection. Returns null when the inner payload fails its lexicon schema
 * or a subject-bearing record (like/repost) references a non-projected target.
 */
function translateRow(row: LedgerRow, bskyCollection: string): AtprotoRecordValue | null {
  const record = row.envelope.record;
  switch (bskyCollection) {
    case BSKY_POST_COLLECTION: {
      const parsed = mentionPostRecordSchema.safeParse(record);
      return parsed.success ? translatePostRecord(parsed.data) : null;
    }
    case BSKY_LIKE_COLLECTION: {
      const parsed = mentionLikeRecordSchema.safeParse(record);
      return parsed.success ? translateLikeRecord(parsed.data) : null;
    }
    case BSKY_REPOST_COLLECTION: {
      const parsed = mentionRepostRecordSchema.safeParse(record);
      return parsed.success ? translateRepostRecord(parsed.data) : null;
    }
    default:
      return null;
  }
}

/**
 * Reduce newest-first ledger `rows` into the live, translated records of one bsky
 * collection: LWW per rkey (first row wins), tombstoned keys removed, malformed
 * payloads skipped. This is the SINGLE materialization rule both the list path
 * (full collection) and the single-get path (one rkey) run, so the two cannot
 * drift. `rows` must already be scoped to `mtnCollection` + the tombstone
 * collection and sorted newest-first; the reducer ignores any other `nsid`.
 */
function reduceLiveRecords(
  rows: LedgerRow[],
  oxyUserId: string,
  bskyCollection: string,
  mtnCollection: string,
): BridgeRecord[] {
  const tombstoned = collectTombstonedKeys(rows);

  const seen = new Set<string>();
  const out: BridgeRecord[] = [];
  for (const row of rows) {
    if (row.nsid !== mtnCollection) continue;
    const rkey = row.rkey;
    if (typeof rkey !== 'string' || rkey.length === 0) continue;

    // LWW: rows are newest-first, so the first row seen for a key is the live one.
    if (seen.has(rkey)) continue;
    seen.add(rkey);

    // Tombstone removal: drop a key explicitly deleted.
    if (tombstoned.has(`${mtnCollection}/${rkey}`)) continue;

    const value = translateRow(row, bskyCollection);
    if (!value) continue;

    out.push({
      uri: `at://${buildUserDid(oxyUserId)}/${bskyCollection}/${rkey}`,
      cid: row.recordId ? `mtn-${row.recordId}` : 'mtn-unknown',
      value,
      rkey,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return out;
}

/**
 * Materialize the CURRENT records of a single bsky collection for a user
 * (LWW per rkey, tombstones removed), newest-first, translated to atproto.
 *
 * Reads ONLY the requested collection + tombstones (not every feed collection),
 * then runs {@link reduceLiveRecords} — the shared rule `getRecord` also uses, so
 * the list and single-get views cannot drift.
 */
async function filterPublicPublishedPosts(
  oxyUserId: string,
  records: BridgeRecord[],
): Promise<BridgeRecord[]> {
  if (records.length === 0) return records;

  const postIds = records.map((record) => record.rkey);
  const publicPosts = await Post.find(
    {
      _id: { $in: postIds },
      oxyUserId,
      status: 'published',
      visibility: PostVisibility.PUBLIC,
    },
    { _id: 1 },
  ).lean<Array<{ _id: unknown }>>();
  const publicPostIds = new Set(publicPosts.map((post) => String(post._id)));
  return records.filter((record) => publicPostIds.has(record.rkey));
}

async function materializeCollection(
  oxyUserId: string,
  bskyCollection: string,
): Promise<BridgeRecord[]> {
  const mtnCollection = BSKY_TO_MTN_COLLECTION[bskyCollection];
  if (!mtnCollection) return [];

  const rows = await readLiveRows(oxyUserId, mtnCollection);
  const records = reduceLiveRecords(rows, oxyUserId, bskyCollection, mtnCollection);
  return bskyCollection === BSKY_POST_COLLECTION
    ? filterPublicPublishedPosts(oxyUserId, records)
    : records;
}

/**
 * `com.atproto.repo.listRecords` for a bridge user + collection. Returns the
 * current materialized records newest-first, paginated by an opaque cursor (the
 * last rkey of the previous page). Unknown/private collections yield an empty
 * page. Never throws on a malformed individual record (it is skipped).
 */
export async function listRecords(
  oxyUserId: string,
  bskyCollection: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ListRecordsPage> {
  let all: BridgeRecord[];
  try {
    all = await materializeCollection(oxyUserId, bskyCollection);
  } catch (err) {
    logger.warn('[atproto-bridge] listRecords materialization failed', {
      oxyUserId,
      collection: bskyCollection,
      error: err instanceof Error ? err.message : String(err),
    });
    return { records: [] };
  }

  // The cursor is the rkey AFTER which to continue. Find its index and slice.
  let startIndex = 0;
  if (opts.cursor) {
    const idx = all.findIndex((record) => record.rkey === opts.cursor);
    startIndex = idx >= 0 ? idx + 1 : all.length;
  }

  const limit = clampLimit(opts.limit);
  const page = all.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < all.length;
  const cursor = hasMore && page.length > 0 ? page[page.length - 1].rkey : undefined;
  return { records: page, cursor };
}

/**
 * `com.atproto.repo.getRecord` — resolve a single record by `(collection, rkey)`.
 * Returns null when the record does not exist, is tombstoned, is in a private
 * collection, or fails translation.
 *
 * Queries ONLY the requested key (plus the tombstone collection, which may delete
 * it) instead of materializing the whole collection, then runs the SAME
 * {@link reduceLiveRecords} rule the list path uses — an O(1)-target read with
 * zero LWW/tombstone-logic drift. Multiple versions of the key (an edit) still
 * collapse via LWW; the single live record (if any) is returned.
 */
export async function getRecord(
  oxyUserId: string,
  bskyCollection: string,
  rkey: string,
): Promise<BridgeRecord | null> {
  const mtnCollection = BSKY_TO_MTN_COLLECTION[bskyCollection];
  if (!mtnCollection) return null;

  const rows = await readLiveRows(oxyUserId, mtnCollection, rkey);
  const liveRecords = reduceLiveRecords(rows, oxyUserId, bskyCollection, mtnCollection);
  const records = bskyCollection === BSKY_POST_COLLECTION
    ? await filterPublicPublishedPosts(oxyUserId, liveRecords)
    : liveRecords;
  return records.find((record) => record.rkey === rkey) ?? null;
}

/** The collections the bridge advertises for a repo (`describeRepo`). */
export const BRIDGE_DESCRIBE_COLLECTIONS = [
  BSKY_POST_COLLECTION,
  BSKY_LIKE_COLLECTION,
  BSKY_REPOST_COLLECTION,
];

/** The chain head summary a bridge repo exposes (drives `getLatestCommit`). */
export interface BridgeRepoHead {
  /** The user's `did:web` subject DID. */
  did: string;
  /** The head sequence (`-1` when the user has no chain yet). */
  seq: number;
  /** The head record's content address, or null at genesis / no chain. */
  headRecordId: string | null;
}
