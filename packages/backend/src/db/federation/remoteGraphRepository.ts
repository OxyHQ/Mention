/**
 * The remote follow-graph mirror: `remote_actor_refs` (one integer per
 * account node), `remote_follow_edges` (two of them per edge) and the per-account
 * crawl state, `remote_graph_crawls`. See the schema docblocks for why the
 * mirror exists, why it is not Oxy's follow graph, and why edges are integers.
 *
 * Four things here are easy to get wrong and are written once:
 *
 * - **Pruning is by `last_seen_at`, scoped to ONE side.** A complete re-crawl of
 *   an account's `following` deletes the edges FROM it the crawl did not stamp,
 *   a complete crawl of its `followers` the edges TO it. A truncated crawl
 *   prunes nothing, or the edges past its cap would disappear.
 * - **Expiry spares an edge whose two ends are both known.** Only an edge with
 *   an end that is still not an account here expires, `ttl` after it was last
 *   seen; the known/unknown test is the same one the lists use.
 * - **A ref goes with the last edge that used it**, in the statement that
 *   deleted that edge, so the dictionary never outgrows the edges.
 * - **A known account matches either spelling of a Bluesky node.** The node is
 *   the DID; the account may be stored here under its Bridgy Fed actor URI.
 */

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { isForeignKeyViolation, qualified } from '@oxy.so/db';
import { BRIDGY_BSKY_ACTOR_PREFIX } from '../../connectors/shared/bridgyActor';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  federatedActors,
  federatedFollows,
  remoteActorRefs,
  remoteFollowEdges,
  remoteGraphCrawls,
  type REMOTE_GRAPH_COLLECTION_STATES,
} from '../schema/federation';

/** `visible` | `hidden`. */
export type RemoteGraphCollectionState = (typeof REMOTE_GRAPH_COLLECTION_STATES)[number];

/** One edge to store: `sourceUri` follows `targetUri` (both canonical nodes). */
export interface RemoteFollowEdgeInput {
  sourceUri: string;
  targetUri: string;
  recordKey?: string;
}

/** URIs per dictionary round trip and edges per INSERT, far under the bind-parameter ceiling. */
const WRITE_BATCH = 1_000;

/**
 * SQL: the canonical node `node` is an account known here — a `federated_actors`
 * row linked to an Oxy user under the node itself or, for a DID, under its
 * Bridgy Fed actor URI. `= any(array[…])` keeps it an index probe on
 * `federated_actors_uri_key`.
 */
function knownNodeSql(node: SQL): SQL {
  return sql`exists (select 1 from ${federatedActors}
    where ${qualified(federatedActors.uri)} = any(array[${node}, ${BRIDGY_BSKY_ACTOR_PREFIX} || ${node}])
      and ${qualified(federatedActors.oxyUserId)} is not null)`;
}

/** The dictionary ids of `uris`, adding the ones not stored yet. */
async function internRefs(
  uris: readonly string[],
  db: DatabaseOrTransaction,
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  const unique = [...new Set(uris)];
  for (let start = 0; start < unique.length; start += WRITE_BATCH) {
    const batch = unique.slice(start, start + WRITE_BATCH);
    await db
      .insert(remoteActorRefs)
      .values(batch.map((uri) => ({ uri })))
      .onConflictDoNothing();
    const rows = await db
      .select({ id: remoteActorRefs.id, uri: remoteActorRefs.uri })
      .from(remoteActorRefs)
      .where(inArray(remoteActorRefs.uri, batch));
    for (const row of rows) ids.set(row.uri, row.id);
  }
  return ids;
}

async function writeEdges(
  edges: readonly RemoteFollowEdgeInput[],
  seenAt: Date,
  db: DatabaseOrTransaction,
): Promise<void> {
  const ids = await internRefs(
    edges.flatMap((edge) => [edge.sourceUri, edge.targetUri]),
    db,
  );
  const rows = edges.flatMap((edge) => {
    const sourceId = ids.get(edge.sourceUri);
    const targetId = ids.get(edge.targetUri);
    return sourceId && targetId && sourceId !== targetId
      ? [{ sourceId, targetId, recordKey: edge.recordKey ?? null, lastSeenAt: seenAt }]
      : [];
  });
  for (let start = 0; start < rows.length; start += WRITE_BATCH) {
    await db
      .insert(remoteFollowEdges)
      .values(rows.slice(start, start + WRITE_BATCH))
      .onConflictDoUpdate({
        target: [remoteFollowEdges.sourceId, remoteFollowEdges.targetId],
        set: {
          lastSeenAt: sql`excluded.last_seen_at`,
          recordKey: sql`coalesce(excluded.record_key, ${remoteFollowEdges.recordKey})`,
        },
      });
  }
}

/**
 * Insert or re-stamp edges. A re-observed edge moves its `last_seen_at` forward
 * (which keeps it through the next prune and the expiry). A ref deleted by a
 * concurrent prune between the two steps fails the foreign key; the write is
 * then retried once, which re-adds it.
 */
export async function upsertRemoteFollowEdges(
  edges: readonly RemoteFollowEdgeInput[],
  seenAt: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (edges.length === 0) return;
  try {
    await writeEdges(edges, seenAt, db);
  } catch (err) {
    if (!isForeignKeyViolation(err)) throw err;
    await writeEdges(edges, seenAt, db);
  }
}

/** Delete the refs among `ids` that no edge uses any more. */
async function deleteOrphanRefs(ids: readonly number[], db: DatabaseOrTransaction): Promise<void> {
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += WRITE_BATCH) {
    const batch = unique.slice(start, start + WRITE_BATCH);
    await db
      .delete(remoteActorRefs)
      .where(
        and(
          inArray(remoteActorRefs.id, batch),
          sql`not exists (select 1 from ${remoteFollowEdges} where ${qualified(remoteFollowEdges.sourceId)} = ${qualified(remoteActorRefs.id)})`,
          sql`not exists (select 1 from ${remoteFollowEdges} where ${qualified(remoteFollowEdges.targetId)} = ${qualified(remoteActorRefs.id)})`,
        ),
      );
  }
}

/** Delete the edges matching `where` and, with them, the refs they leave unused. */
async function deleteEdgesWhere(where: SQL, db: DatabaseOrTransaction): Promise<number> {
  const deleted = await db
    .delete(remoteFollowEdges)
    .where(where)
    .returning({ sourceId: remoteFollowEdges.sourceId, targetId: remoteFollowEdges.targetId });
  if (deleted.length > 0) {
    await deleteOrphanRefs(
      deleted.flatMap((edge) => [edge.sourceId, edge.targetId]),
      db,
    );
  }
  return deleted.length;
}

/**
 * Delete the edges on one side of a node that were not seen since `seenBefore` —
 * after a COMPLETE crawl of that side, or with "now" once the origin hid the
 * collection (which removes them all).
 */
export async function pruneRemoteFollowEdges(
  side: { sourceUri: string } | { targetUri: string },
  seenBefore: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const uri = 'sourceUri' in side ? side.sourceUri : side.targetUri;
  const [ref] = await db
    .select({ id: remoteActorRefs.id })
    .from(remoteActorRefs)
    .where(eq(remoteActorRefs.uri, uri))
    .limit(1);
  if (!ref) return 0;
  const column = 'sourceUri' in side ? remoteFollowEdges.sourceId : remoteFollowEdges.targetId;
  return deleteEdgesWhere(
    and(eq(column, ref.id), lt(remoteFollowEdges.lastSeenAt, seenBefore)) as SQL,
    db,
  );
}

/**
 * One batch of the expiry: edges last seen before `cutoff` with an end that is
 * still not an account here. Edges between two known accounts never expire.
 *
 * @returns how many were deleted; fewer than `batchSize` means the sweep is done.
 */
export async function expireUnknownRemoteFollowEdges(
  cutoff: Date,
  batchSize: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const source = sql`(select ${remoteActorRefs.uri} from ${remoteActorRefs} where ${remoteActorRefs.id} = e.source_id)`;
  const target = sql`(select ${remoteActorRefs.uri} from ${remoteActorRefs} where ${remoteActorRefs.id} = e.target_id)`;
  return deleteEdgesWhere(
    sql`(${remoteFollowEdges.sourceId}, ${remoteFollowEdges.targetId}) in (
      select e.source_id, e.target_id from ${remoteFollowEdges} e
      where e.last_seen_at < ${cutoff.toISOString()}::timestamptz
        and not (${knownNodeSql(source)} and ${knownNodeSql(target)})
      order by e.last_seen_at
      limit ${batchSize})`,
    db,
  );
}

/**
 * Take the crawl lease for one account: never crawled, or crawled before
 * `cooldownCutoff`, and nobody holding a lease newer than `staleLeaseCutoff`.
 * The row count IS the answer, so concurrent triggers cannot crawl one account
 * twice.
 *
 * @returns `true` when this caller owns the lease and must finish it.
 */
export async function claimRemoteGraphCrawl(
  actorUri: string,
  now: Date,
  cooldownCutoff: Date,
  staleLeaseCutoff: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const claimed = await db
    .insert(remoteGraphCrawls)
    .values({ actorUri, crawlStartedAt: now })
    .onConflictDoUpdate({
      target: remoteGraphCrawls.actorUri,
      set: { crawlStartedAt: now, updatedAt: now },
      setWhere: and(
        or(isNull(remoteGraphCrawls.crawledAt), lte(remoteGraphCrawls.crawledAt, cooldownCutoff)),
        or(
          isNull(remoteGraphCrawls.crawlStartedAt),
          lte(remoteGraphCrawls.crawlStartedAt, staleLeaseCutoff),
        ),
      ),
    })
    .returning({ actorUri: remoteGraphCrawls.actorUri });
  return claimed.length > 0;
}

/** What a finished crawl learned about the account's two collections. */
export interface RemoteGraphCrawlOutcome {
  /** False releases the lease without stamping the cooldown, so the next trigger retries. */
  completed: boolean;
  /** Undefined leaves the stored state as it was (the collection could not be read). */
  followingState?: RemoteGraphCollectionState;
  followersState?: RemoteGraphCollectionState;
}

/**
 * Release the lease taken by {@link claimRemoteGraphCrawl}. `heldSince` is in the
 * predicate so a late finisher whose lease was re-claimed writes nothing.
 */
export async function finishRemoteGraphCrawl(
  actorUri: string,
  heldSince: Date,
  outcome: RemoteGraphCrawlOutcome,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = new Date();
  await db
    .update(remoteGraphCrawls)
    .set({
      crawlStartedAt: null,
      updatedAt: now,
      ...(outcome.completed ? { crawledAt: now } : {}),
      ...(outcome.followingState ? { followingState: outcome.followingState } : {}),
      ...(outcome.followersState ? { followersState: outcome.followersState } : {}),
    })
    .where(
      and(
        eq(remoteGraphCrawls.actorUri, actorUri),
        eq(remoteGraphCrawls.crawlStartedAt, heldSince),
      ),
    );
}

/** A collection's two states, as stored for one account. */
export interface RemoteGraphStates {
  followingState?: RemoteGraphCollectionState;
  followersState?: RemoteGraphCollectionState;
}

/** The collection states of a set of accounts; an account never crawled is absent. */
export async function loadRemoteGraphStates(
  actorUris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, RemoteGraphStates>> {
  const states = new Map<string, RemoteGraphStates>();
  if (actorUris.length === 0) return states;
  const rows = await db
    .select({
      actorUri: remoteGraphCrawls.actorUri,
      followingState: remoteGraphCrawls.followingState,
      followersState: remoteGraphCrawls.followersState,
    })
    .from(remoteGraphCrawls)
    .where(inArray(remoteGraphCrawls.actorUri, [...actorUris]));
  for (const row of rows) {
    states.set(row.actorUri, {
      followingState: row.followingState ?? undefined,
      followersState: row.followersState ?? undefined,
    });
  }
  return states;
}

/** The actor columns a crawl needs. */
export interface RemoteGraphCrawlSubject {
  uri: string;
  protocol: (typeof federatedActors.$inferSelect)['protocol'];
  followingUrl?: string;
  followersUrl?: string;
  followersCount?: number;
}

/**
 * Accounts a local user follows (an accepted outbound follow) whose graph is due
 * a crawl — never crawled, or not since `cooldownCutoff` — least recently
 * crawled first. The sweep's whole population: the set of accounts people here
 * chose, which is small and grows only with them.
 */
export async function findFollowedActorsDueForGraphCrawl(
  protocols: ReadonlyArray<'activitypub' | 'atproto'>,
  cooldownCutoff: Date,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<RemoteGraphCrawlSubject[]> {
  if (protocols.length === 0) return [];
  const followed = db
    .selectDistinct({ uri: federatedFollows.remoteActorUri })
    .from(federatedFollows)
    .where(
      and(eq(federatedFollows.direction, 'outbound'), eq(federatedFollows.status, 'accepted')),
    );
  const rows = await db
    .select({
      uri: federatedActors.uri,
      protocol: federatedActors.protocol,
      followingUrl: federatedActors.followingUrl,
      followersUrl: federatedActors.followersUrl,
      followersCount: federatedActors.followersCount,
    })
    .from(federatedActors)
    .leftJoin(remoteGraphCrawls, eq(remoteGraphCrawls.actorUri, federatedActors.uri))
    .where(
      and(
        inArray(federatedActors.uri, followed),
        isNotNull(federatedActors.oxyUserId),
        inArray(federatedActors.protocol, [...protocols]),
        eq(federatedActors.suspended, false),
        or(isNull(remoteGraphCrawls.crawledAt), lte(remoteGraphCrawls.crawledAt, cooldownCutoff)),
      ),
    )
    .orderBy(sql`${remoteGraphCrawls.crawledAt} asc nulls first`)
    .limit(limit);
  return rows.map((row) => ({
    uri: row.uri,
    protocol: row.protocol,
    followingUrl: row.followingUrl ?? undefined,
    followersUrl: row.followersUrl ?? undefined,
    followersCount: row.followersCount ?? undefined,
  }));
}

/** One page of a profile's mirrored connections. */
export interface MirroredConnectionsQuery {
  /** Every canonical node of the profile (one Oxy identity can hold several). */
  selfNodes: readonly string[];
  /** The profile's own Oxy id, never listed on its own lists. */
  profileUserId: string;
  kind: 'followers' | 'following';
  /** Accounts the viewer blocked, muted or restricted. */
  excludedUserIds: ReadonlySet<string>;
  /** Signed-out viewers do not see accounts that hide themselves from them. */
  signedIn: boolean;
  afterUserId?: string;
  limit: number;
}

/**
 * The Oxy ids of the KNOWN accounts on the other end of a profile's mirrored
 * edges, in id order (a stable keyset). An edge whose other end is not linked to
 * an Oxy user, or is suspended, lists nobody; a Bluesky node matches its account
 * under either spelling.
 */
export async function pageMirroredConnections(
  query: MirroredConnectionsQuery,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (query.selfNodes.length === 0 || query.limit <= 0) return [];
  const selfSide =
    query.kind === 'followers' ? remoteFollowEdges.targetId : remoteFollowEdges.sourceId;
  const otherSide =
    query.kind === 'followers' ? remoteFollowEdges.sourceId : remoteFollowEdges.targetId;
  const selfIds = db
    .select({ id: remoteActorRefs.id })
    .from(remoteActorRefs)
    .where(inArray(remoteActorRefs.uri, [...query.selfNodes]));
  const excluded = [...query.excludedUserIds];
  const rows = await db
    .selectDistinct({ oxyUserId: federatedActors.oxyUserId })
    .from(remoteFollowEdges)
    .innerJoin(remoteActorRefs, eq(remoteActorRefs.id, otherSide))
    .innerJoin(
      federatedActors,
      sql`${federatedActors.uri} = any(array[${remoteActorRefs.uri}, ${BRIDGY_BSKY_ACTOR_PREFIX} || ${remoteActorRefs.uri}])`,
    )
    .where(
      and(
        inArray(selfSide, selfIds),
        isNotNull(federatedActors.oxyUserId),
        sql`${federatedActors.oxyUserId} <> ${query.profileUserId}`,
        eq(federatedActors.suspended, false),
        query.signedIn ? undefined : eq(federatedActors.requiresSignIn, false),
        excluded.length > 0 ? notInArray(federatedActors.oxyUserId, excluded) : undefined,
        query.afterUserId ? gt(federatedActors.oxyUserId, query.afterUserId) : undefined,
      ),
    )
    .orderBy(asc(federatedActors.oxyUserId))
    .limit(query.limit);
  return rows.flatMap((row) => (row.oxyUserId ? [row.oxyUserId] : []));
}
