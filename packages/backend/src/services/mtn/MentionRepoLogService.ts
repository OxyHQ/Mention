/**
 * Mention Repo Log Service — the focused READ helpers over the MTN chain that the
 * node-sync export side needs (the inbound ingest side re-verifies + appends via
 * `MentionRecordService.verifyAndStoreRecord` + the `mentionRecordStore`).
 *
 * Mirrors oxy-api's `repoLog.service.ts` (`getHead` / `getPublicLogSince`),
 * scoped to Mention's Mongo and keyed by `oxyUserId` (a string). The ONE
 * difference from the store's raw `getLogSince` is the PUBLIC-collection
 * allowlist: a node export/public log MUST exclude private collections
 * (`app.mention.feed.bookmark`), so `getPublicLogSince` filters the ledger to
 * {@link MENTION_NODE_PUBLIC_COLLECTIONS}. The raw store log (used internally by
 * the protocol engine) is unchanged.
 *
 * Read-path note: these helpers are consumed ONLY by the background export worker
 * (`MentionNodeSyncService.exportToNode`) — never by a request's read path. They
 * read Mention's own Mongo (no node fetch).
 */

import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import type { ChainHead } from '@oxyhq/protocol';
import MentionSignedRecord from '../../models/MentionSignedRecord';
import { mentionRecordStore } from './MentionRecordStore';
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
 */
export async function getPublicLogSince(
  oxyUserId: string,
  sinceSeq: number,
  limit: number = DEFAULT_PUBLIC_LOG_LIMIT,
): Promise<SignedRecordEnvelope[]> {
  const rows = await MentionSignedRecord.find({
    oxyUserId,
    seq: { $gt: sinceSeq },
    nsid: { $in: MENTION_NODE_PUBLIC_COLLECTIONS },
  })
    .sort({ seq: 1 })
    .limit(clampLimit(limit))
    .lean<Array<{ envelope: SignedRecordEnvelope }>>();
  return rows.map((row) => row.envelope);
}
