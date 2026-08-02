/**
 * `mention_user_nodes` + `mention_node_ingest_witnesses` — a user's registered
 * personal data node, and Mention's counter-signature over what it ingested.
 *
 * Everything here runs in the BACKGROUND. The read-path invariant on
 * `services/mtn/MentionNodeScheduler.ts` is that nothing in a feed or hydration
 * request ever reaches a node, so every one of these queries is a sweep, a probe
 * or a registration — which means nothing is watching when one of them answers
 * wrongly. Three translations would have failed that way, silently, and are
 * called out where they live:
 *
 *  - **The sweeps order `NULLS FIRST`.** A node that has never been probed or
 *    never been synced has a `NULL` in the column the sweep orders by. Mongo
 *    sorted a missing field FIRST on `sort({field: 1})`; Postgres puts NULLs
 *    LAST on a bare `ASC`. Bare, a freshly-registered node sorts behind every
 *    node that has ever been touched and is starved out of the batch — worst on
 *    the smallest deployments, where it never gets probed at all, and reported
 *    by nothing.
 *  - **A negative cursor is stored as `NULL`.** `-1` is the ingest loop's "no
 *    chain yet" sentinel (`Math.max(node.cursor ?? -1, localHeadSeq)`), and
 *    `mention_user_nodes_cursor_check` rejects it. Postgres spells that state
 *    `NULL`, so the sentinel is translated at the boundary rather than left to
 *    throw inside a worker whose whole contract is that it never throws.
 *  - **Witnessing is `ON CONFLICT DO NOTHING`.** It replaces a caught `E11000`;
 *    re-pulling a record must stay idempotent, and the witness table is
 *    append-only — never updated, so a conflict has nothing to write.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  MENTION_NODE_CONTROLLERS,
  MENTION_NODE_MODES,
  MENTION_NODE_STATUSES,
  mentionNodeIngestWitnesses,
  mentionUserNodes,
} from '../schema/mtn';

/** How Mention and the node move records. */
export type MentionUserNodeMode = (typeof MENTION_NODE_MODES)[number];
/** Who operates the node — the user, or Mention on their behalf. */
export type MentionUserNodeController = (typeof MENTION_NODE_CONTROLLERS)[number];
/** Liveness state of the node. */
export type MentionUserNodeStatus = (typeof MENTION_NODE_STATUSES)[number];

/** One registered node, as every caller outside this module sees it. */
export interface MentionUserNodeRecord {
  oxyUserId: string;
  nodeDid?: string;
  endpoint: string;
  nodePublicKey: string;
  mode: MentionUserNodeMode;
  managed: boolean;
  controller: MentionUserNodeController;
  status: MentionUserNodeStatus;
  lastSeenAt?: Date;
  lastProbeAt?: Date;
  lastError?: string;
  cursor?: number;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** What a verified `app.mention.node` record projects into the cache. */
export interface NodeRegistration {
  endpoint: string;
  nodePublicKey: string;
  mode: MentionUserNodeMode;
  managed: boolean;
  controller: MentionUserNodeController;
  nodeDid?: string;
}

/** The outcome of one liveness probe. */
export type NodeLivenessUpdate =
  | { reachable: true; probedAt: Date }
  | { reachable: false; probedAt: Date; error: string };

/** A node the sync sweep must service, and which direction it moves. */
export interface NodeSyncTarget {
  oxyUserId: string;
  mode: MentionUserNodeMode;
}

/** What the ingest loop needs to resume a node's chain. */
export interface IngestNodeTarget {
  endpoint: string;
  cursor?: number;
}

/**
 * Only a non-revoked node participates in anything.
 *
 * Every read and every background write carries this, so a user who revoked
 * their node cannot be probed, synced or exported to by a sweep that was already
 * in flight.
 */
const NOT_REVOKED = ne(mentionUserNodes.status, 'revoked');

/**
 * The chain position to STORE for an in-memory cursor.
 *
 * `-1` means "nothing mirrored yet" to the ingest loop and is rejected by the
 * column's CHECK; `NULL` is how the column spells the same thing.
 */
function storedCursor(cursor: number): number | null {
  return cursor < 0 ? null : cursor;
}

function toRecord(row: typeof mentionUserNodes.$inferSelect): MentionUserNodeRecord {
  return {
    oxyUserId: row.oxyUserId,
    nodeDid: row.nodeDid ?? undefined,
    endpoint: row.endpoint,
    nodePublicKey: row.nodePublicKey,
    mode: row.mode,
    managed: row.managed,
    controller: row.controller,
    status: row.status,
    lastSeenAt: row.lastSeenAt ?? undefined,
    lastProbeAt: row.lastProbeAt ?? undefined,
    lastError: row.lastError ?? undefined,
    cursor: row.cursor ?? undefined,
    lastSyncedAt: row.lastSyncedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Upsert the cache row for a verified node registration, and return it.
 *
 * Re-registering writes `managed` and `controller` every time, so flipping a
 * self-hosted node to a managed vault (or back) is deterministic. `nodeDid` is
 * only overwritten when the new record carries one — a record that omits it
 * leaves the previously advertised DID in place, which is what the Mongo
 * conditional `$set` did.
 *
 * `status` returns to `active` and `lastError` is cleared: a fresh signed
 * registration supersedes whatever the last probe concluded.
 */
export async function upsertNodeRegistration(
  oxyUserId: string,
  registration: NodeRegistration,
  db: DatabaseOrTransaction = getDb(),
): Promise<MentionUserNodeRecord | undefined> {
  const shared = {
    endpoint: registration.endpoint,
    nodePublicKey: registration.nodePublicKey,
    mode: registration.mode,
    managed: registration.managed,
    controller: registration.controller,
    status: 'active' as const,
    lastError: null,
    ...(registration.nodeDid === undefined ? {} : { nodeDid: registration.nodeDid }),
  };

  const [row] = await db
    .insert(mentionUserNodes)
    .values({ oxyUserId, ...shared })
    .onConflictDoUpdate({ target: mentionUserNodes.oxyUserId, set: shared })
    .returning();

  return row ? toRecord(row) : undefined;
}

/** The endpoint of a user's live node, or `undefined` when there is none. */
export async function findNodeEndpoint(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | undefined> {
  const [row] = await db
    .select({ endpoint: mentionUserNodes.endpoint })
    .from(mentionUserNodes)
    .where(and(eq(mentionUserNodes.oxyUserId, oxyUserId), NOT_REVOKED))
    .limit(1);
  return row?.endpoint;
}

/** Whether the user has a node that is not revoked. */
export async function hasLiveNode(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: mentionUserNodes.id })
    .from(mentionUserNodes)
    .where(and(eq(mentionUserNodes.oxyUserId, oxyUserId), NOT_REVOKED))
    .limit(1);
  return row !== undefined;
}

/** Record what one liveness probe concluded. */
export async function recordNodeLiveness(
  oxyUserId: string,
  outcome: NodeLivenessUpdate,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const set = outcome.reachable
    ? {
        status: 'active' as const,
        lastSeenAt: outcome.probedAt,
        lastProbeAt: outcome.probedAt,
        lastError: null,
      }
    : {
        status: 'unreachable' as const,
        lastProbeAt: outcome.probedAt,
        lastError: outcome.error,
      };

  await db
    .update(mentionUserNodes)
    .set(set)
    .where(and(eq(mentionUserNodes.oxyUserId, oxyUserId), NOT_REVOKED));
}

/**
 * The next batch of nodes to probe, least-recently-probed first.
 *
 * `NULLS FIRST` is load-bearing — see the module comment. A node registered a
 * minute ago has never been probed, and it is the one most worth probing.
 */
export async function findNodesToProbe(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ oxyUserId: mentionUserNodes.oxyUserId })
    .from(mentionUserNodes)
    .where(inArray(mentionUserNodes.status, ['active', 'unreachable']))
    .orderBy(sql`${mentionUserNodes.lastProbeAt} asc nulls first`)
    .limit(limit);
  return rows.map((row) => row.oxyUserId);
}

/**
 * The next batch of nodes to sync, least-recently-synced first.
 *
 * Same `NULLS FIRST` reasoning as {@link findNodesToProbe}: a node that has
 * never synced must lead the queue, not trail it.
 */
export async function findNodesToSync(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<NodeSyncTarget[]> {
  return db
    .select({ oxyUserId: mentionUserNodes.oxyUserId, mode: mentionUserNodes.mode })
    .from(mentionUserNodes)
    .where(inArray(mentionUserNodes.status, ['active', 'unreachable']))
    .orderBy(sql`${mentionUserNodes.lastSyncedAt} asc nulls first`)
    .limit(limit);
}

/** A user's node whatever its status, for the settings screen. */
export async function findUserNode(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MentionUserNodeRecord | undefined> {
  const [row] = await db
    .select()
    .from(mentionUserNodes)
    .where(eq(mentionUserNodes.oxyUserId, oxyUserId))
    .limit(1);
  return row ? toRecord(row) : undefined;
}

/** What the ingest loop needs to resume, or `undefined` when there is no node. */
export async function findIngestTarget(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<IngestNodeTarget | undefined> {
  const [row] = await db
    .select({ endpoint: mentionUserNodes.endpoint, cursor: mentionUserNodes.cursor })
    .from(mentionUserNodes)
    .where(and(eq(mentionUserNodes.oxyUserId, oxyUserId), NOT_REVOKED))
    .limit(1);
  if (!row) return undefined;
  return { endpoint: row.endpoint, cursor: row.cursor ?? undefined };
}

/**
 * Revoke a user's node registration.
 *
 * @returns Whether a non-revoked row was flipped — `false` means there was
 *   nothing to revoke, not that the write failed.
 */
export async function revokeNode(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const revoked = await db
    .update(mentionUserNodes)
    .set({ status: 'revoked', lastError: null })
    .where(and(eq(mentionUserNodes.oxyUserId, oxyUserId), NOT_REVOKED))
    .returning({ id: mentionUserNodes.id });
  return revoked.length > 0;
}

/** Advance the mirror cursor and stamp the sync, optionally clearing `lastError`. */
export async function markNodeSynced(
  oxyUserId: string,
  cursor: number,
  clearError: boolean,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(mentionUserNodes)
    .set({
      cursor: storedCursor(cursor),
      lastSyncedAt: new Date(),
      ...(clearError ? { lastError: null } : {}),
    })
    .where(and(eq(mentionUserNodes.oxyUserId, oxyUserId), NOT_REVOKED));
}

/** Stamp a sync that stopped early, keeping the reason on the row. */
export async function markNodeSyncStopped(
  oxyUserId: string,
  cursor: number,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(mentionUserNodes)
    .set({ cursor: storedCursor(cursor), lastSyncedAt: new Date(), lastError: reason })
    .where(and(eq(mentionUserNodes.oxyUserId, oxyUserId), NOT_REVOKED));
}

/** Record a non-throwing sync failure on the node row. */
export async function recordNodeSyncError(
  oxyUserId: string,
  message: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(mentionUserNodes)
    .set({ lastError: message, lastSyncedAt: new Date() })
    .where(and(eq(mentionUserNodes.oxyUserId, oxyUserId), NOT_REVOKED));
}

/**
 * Counter-sign one ingested record, idempotently.
 *
 * The witness table is append-only and never updated, so a record re-pulled on a
 * later sweep must leave the FIRST attestation exactly as it was — that first
 * sighting is the whole point of the table. Hence `DO NOTHING` rather than a
 * conflict update.
 *
 * @returns Whether this call wrote the witness. `false` means it was already
 *   witnessed, which is the expected outcome on a re-pull.
 */
export async function witnessIngestedRecord(
  witness: {
    oxyUserId: string;
    recordId: string;
    witnessSignature: string;
    ingestedAt: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const inserted = await db
    .insert(mentionNodeIngestWitnesses)
    .values(witness)
    .onConflictDoNothing({ target: mentionNodeIngestWitnesses.recordId })
    .returning({ id: mentionNodeIngestWitnesses.id });
  return inserted.length > 0;
}
