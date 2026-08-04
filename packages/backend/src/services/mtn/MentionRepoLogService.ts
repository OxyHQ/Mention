/**
 * Mention Repo Log Service — the focused READ helpers over the MTN chain that the
 * node-sync export side needs (the inbound ingest side re-verifies + appends via
 * `MentionRecordService.verifyAndStoreRecord` + the `mentionRecordStore`).
 *
 * Mirrors oxy-api's `repoLog.service.ts` (`getHead` / `getPublicLogSince`),
 * scoped to Mention's own `mention_signed_records` table and keyed by `oxyUserId`
 * (a string). The ONE difference from the store's raw `getLogSince` is the
 * PUBLIC-collection allowlist: a node export/public log MUST exclude private
 * collections (`app.mention.feed.bookmark`), so `getPublicLogSince` filters the
 * ledger to {@link MENTION_NODE_PUBLIC_COLLECTIONS}. The raw store log (used
 * internally by the protocol engine) is unchanged.
 *
 * Read-path note: these helpers are consumed ONLY by the background export worker
 * (`MentionNodeSyncService.exportToNode`) — never by a request's read path. They
 * read Mention's own database (no node fetch).
 */

import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import type { ChainHead } from '@oxyhq/protocol';
import { getDb } from '../../db/postgres';
import { mentionSignedRecords } from '../../db/schema/mtn';
import { canonicalChainRow, mentionRecordStore } from './MentionRecordStore';
import { buildUserDid } from './mentionDid';
import { MENTION_NODE_PUBLIC_COLLECTIONS } from './mentionNodes.constants';

/** Default page size for the public-log read (matches the store's default). */
export const DEFAULT_PUBLIC_LOG_LIMIT = 100;
/** Hard ceiling so a single public-log call can never scan an unbounded slice. */
const MAX_PUBLIC_LOG_LIMIT = 500;

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || DEFAULT_PUBLIC_LOG_LIMIT, MAX_PUBLIC_LOG_LIMIT));
}

/** The subject's chain head, or `null` when the user has no chain yet. */
export async function getHead(oxyUserId: string): Promise<ChainHead | null> {
  return mentionRecordStore.getHead(buildUserDid(oxyUserId));
}

/**
 * The ordered slice of a user's PUBLIC signed-record log strictly after
 * `sinceSeq`, capped at `limit`. Excludes private collections (bookmarks) via the
 * {@link MENTION_NODE_PUBLIC_COLLECTIONS} allowlist — so a node export / public
 * log never leaks them. Returns verbatim envelopes in `seq` order.
 *
 * Tombstones ARE public (a deletion is part of the public history), so a puller
 * sees the record removal — only the bookmark collection is withheld.
 *
 * The allowlist goes through `inArray`, never a JS array interpolated into `sql`:
 * a raw array binds as a ROW constructor, and `= any(<row>)` / `<> all(<row>)`
 * are both wrong (Postgres raises "op ANY/ALL (array) requires array on right
 * side"). `inArray` also reproduces Mongo's `$in` for a NULL `nsid` — a v1 row
 * with no collection matches neither.
 */
export async function getPublicLogSince(
  oxyUserId: string,
  sinceSeq: number,
  limit: number = DEFAULT_PUBLIC_LOG_LIMIT,
): Promise<SignedRecordEnvelope[]> {
  const rows = await getDb()
    .select({ envelope: mentionSignedRecords.envelope })
    .from(mentionSignedRecords)
    .where(
      and(
        eq(mentionSignedRecords.oxyUserId, oxyUserId),
        gt(mentionSignedRecords.seq, sinceSeq),
        inArray(mentionSignedRecords.nsid, [...MENTION_NODE_PUBLIC_COLLECTIONS]),
        canonicalChainRow(),
      ),
    )
    .orderBy(asc(mentionSignedRecords.seq))
    .limit(clampLimit(limit));
  return rows.map((row) => row.envelope);
}
