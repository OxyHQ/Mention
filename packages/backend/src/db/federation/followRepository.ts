/**
 * `federated_follows` — every follow edge that crosses a protocol boundary.
 *
 * One table, so there is no assembly to hide; what this module exists for is the
 * `UNIQUE (local_user_id, remote_actor_uri, direction)` constraint, which is the
 * only thing that makes an inbound Follow idempotent under redelivery, and the
 * handful of predicates that are easy to translate WRONG.
 *
 * ## `updateOne` is not `UPDATE`
 *
 * Mongo's `updateOne` writes AT MOST ONE document; a bare SQL `UPDATE` writes
 * every matching row. Three of the follow transitions are matched by
 * `(remote_actor_uri, direction, status)` WITHOUT a local user — an `Accept` that
 * arrives with no resolvable Follow id has to guess which pending row it answers
 * — so on any instance where two local users follow the same remote actor, the
 * direct translation accepts BOTH from one Accept. Each of those three goes
 * through {@link oneRowMatching}, which pins the update to a single id chosen by
 * the same predicate.
 *
 * The arbitrariness is inherited, not introduced: Mongo picked whichever row its
 * index scan reached first. Preserving "exactly one" is the point — widening it
 * would mean a remote server could accept a follow it was never asked about.
 */

import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { federatedFollows } from '../schema/federation';

type FollowRow = typeof federatedFollows.$inferSelect;

/** `outbound` (we follow them) | `inbound` (they follow us). */
export type FollowDirection = FollowRow['direction'];
/** `pending` | `accepted` | `rejected`. */
export type FollowStatus = FollowRow['status'];
/** `activitypub` | `atproto`. */
export type FollowNetwork = FollowRow['network'];

/** One follow edge, as consumers read it. */
export interface FederatedFollowRecord {
  id: string;
  localUserId: string;
  remoteActorUri: string;
  direction: FollowDirection;
  status: FollowStatus;
  network: FollowNetwork;
  /** The Follow activity URI we published. Remote servers hold this value. */
  activityId?: string;
  createdAt: Date;
  updatedAt: Date;
}

function assemble(row: FollowRow): FederatedFollowRecord {
  return {
    id: row.id,
    localUserId: row.localUserId,
    remoteActorUri: row.remoteActorUri,
    direction: row.direction,
    status: row.status,
    network: row.network,
    activityId: row.activityId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A predicate narrowed to ONE row — the `updateOne` / `deleteOne` semantics.
 *
 * The inner select is built by drizzle rather than written as a raw `sql`
 * template, which is what keeps its column references qualified: a hand-written
 * subquery that names its own `FROM` renders an interpolated column BARE, so an
 * outer-table reference silently resolves against the subquery's table instead.
 * Here both sides are the same table, so the bug would not merely return the
 * wrong row — it would return one that matched nothing the caller asked for.
 */
function oneRowMatching(where: SQL | undefined): SQL {
  const target = getDb()
    .select({ id: federatedFollows.id })
    .from(federatedFollows)
    .where(where)
    .orderBy(asc(federatedFollows.id))
    .limit(1);
  return inArray(federatedFollows.id, target);
}

/** What a follow-edge listing narrows to. Every field is optional and ANDed. */
export interface FollowFilter {
  localUserId?: string;
  /**
   * SEVERAL local accounts at once — the cross-account thread audience, which
   * asks about every participant in one statement rather than one read each.
   * Empty means "no account can match", exactly like {@link FollowFilter.statuses}.
   */
  localUserIds?: readonly string[];
  remoteActorUri?: string;
  direction?: FollowDirection;
  statuses?: readonly FollowStatus[];
}

function followClauses(filter: FollowFilter): SQL[] | null {
  const clauses: SQL[] = [];
  if (filter.localUserId !== undefined) clauses.push(eq(federatedFollows.localUserId, filter.localUserId));
  if (filter.localUserIds !== undefined) {
    if (filter.localUserIds.length === 0) return null;
    clauses.push(inArray(federatedFollows.localUserId, [...filter.localUserIds]));
  }
  if (filter.remoteActorUri !== undefined) {
    clauses.push(eq(federatedFollows.remoteActorUri, filter.remoteActorUri));
  }
  if (filter.direction !== undefined) clauses.push(eq(federatedFollows.direction, filter.direction));
  if (filter.statuses !== undefined) {
    // An empty status list means "no status can match", not "any status" — the
    // opposite of what dropping the clause would mean. `null` says so to the
    // caller, which returns early rather than running an unfiltered query.
    if (filter.statuses.length === 0) return null;
    clauses.push(inArray(federatedFollows.status, [...filter.statuses]));
  }
  return clauses;
}

/**
 * Whether ANY row matches — the "is this actor followed by someone here?" gate
 * and the "does the viewer follow this actor?" one.
 *
 * `LIMIT 1` on a projection of the id: both callers want a boolean, and one of
 * them asks it about a viewer who may follow thousands of remote actors.
 */
export async function existsFollow(
  filter: FollowFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const clauses = followClauses(filter);
  if (clauses === null) return false;

  const rows = await db
    .select({ id: federatedFollows.id })
    .from(federatedFollows)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .limit(1);
  return rows.length > 0;
}

/**
 * How many edges match a filter.
 *
 * Separate from {@link findFollows} because the purge counts a domain's accepted
 * outbound follows BEFORE deleting them — that number is what the automatic
 * path's circuit breaker refuses on, so pulling every row across the wire to
 * take its length would make a safety measurement pay for rows nobody reads.
 */
export async function countFollows(
  filter: FollowFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const clauses = followClauses(filter);
  if (clauses === null) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(federatedFollows)
    .where(clauses.length > 0 ? and(...clauses) : undefined);
  return row?.count ?? 0;
}

/** Every follow edge matching a filter. */
export async function findFollows(
  filter: FollowFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedFollowRecord[]> {
  const clauses = followClauses(filter);
  if (clauses === null) return [];
  const rows = await db
    .select()
    .from(federatedFollows)
    .where(clauses.length > 0 ? and(...clauses) : undefined);
  return rows.map(assemble);
}

/**
 * The DISTINCT remote actor URIs matching a filter — the follow-graph reads.
 *
 * `selectDistinct` rather than a `Set` built in TypeScript: these callers union
 * the result into a feed's `followingIds`, and pulling every duplicate row across
 * the wire to discard it is the difference between one round trip and one per
 * follower on a well-connected account.
 */
export async function distinctRemoteActorUris(
  filter: FollowFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const clauses = followClauses(filter);
  if (clauses === null) return [];

  const rows = await db
    .selectDistinct({ remoteActorUri: federatedFollows.remoteActorUri })
    .from(federatedFollows)
    .where(clauses.length > 0 ? and(...clauses) : undefined);
  return rows.map((row) => row.remoteActorUri);
}

/** One edge identified by the unique triple, or `null`. */
export async function findFollow(
  localUserId: string,
  remoteActorUri: string,
  direction: FollowDirection,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedFollowRecord | null> {
  const [row] = await db
    .select()
    .from(federatedFollows)
    .where(
      and(
        eq(federatedFollows.localUserId, localUserId),
        eq(federatedFollows.remoteActorUri, remoteActorUri),
        eq(federatedFollows.direction, direction),
      ),
    )
    .limit(1);
  return row ? assemble(row) : null;
}

/**
 * The inbound edge for a remote actor, optionally scoped to one local user.
 *
 * An `Undo(Follow)` may or may not name the local target, so the engine asks for
 * "the inbound follow from this actor" and takes whichever row answers when it
 * cannot narrow further — the shape Mongo's `findOne` had.
 */
export async function findInboundFollow(
  remoteActorUri: string,
  localUserId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedFollowRecord | null> {
  const clauses: SQL[] = [
    eq(federatedFollows.remoteActorUri, remoteActorUri),
    eq(federatedFollows.direction, 'inbound'),
  ];
  if (localUserId !== undefined) clauses.push(eq(federatedFollows.localUserId, localUserId));

  const [row] = await db
    .select()
    .from(federatedFollows)
    .where(and(...clauses))
    .orderBy(asc(federatedFollows.id))
    .limit(1);
  return row ? assemble(row) : null;
}

/**
 * Record an accepted INBOUND follow.
 *
 * `ON CONFLICT` on the unique triple is what makes a redelivered Follow a no-op
 * instead of a duplicate follower: ActivityPub servers retry deliveries freely,
 * and the AP-side row is what the sharing-off cleanup later enumerates to unwind
 * the Oxy edges.
 */
export async function upsertInboundAccepted(
  localUserId: string,
  remoteActorUri: string,
  activityId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(federatedFollows)
    .values({
      localUserId,
      remoteActorUri,
      direction: 'inbound',
      status: 'accepted',
      activityId: activityId ?? null,
    })
    .onConflictDoUpdate({
      target: [federatedFollows.localUserId, federatedFollows.remoteActorUri, federatedFollows.direction],
      set: { status: 'accepted', activityId: activityId ?? null, updatedAt: new Date() },
    });
}

/** Record (or re-record) a pending OUTBOUND follow we just sent. */
export async function upsertOutboundPending(
  localUserId: string,
  remoteActorUri: string,
  activityId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(federatedFollows)
    .values({
      localUserId,
      remoteActorUri,
      direction: 'outbound',
      status: 'pending',
      activityId: activityId ?? null,
    })
    .onConflictDoUpdate({
      target: [federatedFollows.localUserId, federatedFollows.remoteActorUri, federatedFollows.direction],
      set: { status: 'pending', activityId: activityId ?? null, updatedAt: new Date() },
    });
}

/**
 * Record an atproto subscription.
 *
 * There is no wire Follow for atproto — the edge is a local subscription that
 * makes the actor's posts backfill — so it is written straight to `accepted`.
 */
export async function upsertOutboundAcceptedSubscription(
  localUserId: string,
  remoteActorUri: string,
  network: FollowNetwork,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(federatedFollows)
    .values({
      localUserId,
      remoteActorUri,
      direction: 'outbound',
      status: 'accepted',
      network,
    })
    .onConflictDoUpdate({
      target: [federatedFollows.localUserId, federatedFollows.remoteActorUri, federatedFollows.direction],
      set: { status: 'accepted', network, updatedAt: new Date() },
    });
}

/**
 * Accept the pending outbound follow this Accept names by activity id.
 *
 * @returns whether a row was accepted, so the engine can fall back to
 *   {@link markOutboundAcceptedAnyPending} when the Accept carried a string ref
 *   whose id matches nothing.
 */
export async function markOutboundAcceptedByActivityId(
  remoteActorUri: string,
  activityId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(federatedFollows)
    .set({ status: 'accepted', updatedAt: new Date() })
    .where(
      oneRowMatching(
        and(
          eq(federatedFollows.remoteActorUri, remoteActorUri),
          eq(federatedFollows.direction, 'outbound'),
          eq(federatedFollows.status, 'pending'),
          eq(federatedFollows.activityId, activityId),
        ),
      ),
    )
    .returning({ id: federatedFollows.id });
  return updated.length > 0;
}

/** Accept ANY pending outbound follow to this actor — the id-less Accept fallback. */
export async function markOutboundAcceptedAnyPending(
  remoteActorUri: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(federatedFollows)
    .set({ status: 'accepted', updatedAt: new Date() })
    .where(
      oneRowMatching(
        and(
          eq(federatedFollows.remoteActorUri, remoteActorUri),
          eq(federatedFollows.direction, 'outbound'),
          eq(federatedFollows.status, 'pending'),
        ),
      ),
    )
    .returning({ id: federatedFollows.id });
  return updated.length > 0;
}

/** Reject a pending outbound follow, narrowed by activity id when the Reject names one. */
export async function markOutboundRejected(
  remoteActorUri: string,
  activityId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const clauses: SQL[] = [
    eq(federatedFollows.remoteActorUri, remoteActorUri),
    eq(federatedFollows.direction, 'outbound'),
    eq(federatedFollows.status, 'pending'),
  ];
  if (activityId !== undefined) clauses.push(eq(federatedFollows.activityId, activityId));

  await db
    .update(federatedFollows)
    .set({ status: 'rejected', updatedAt: new Date() })
    .where(oneRowMatching(and(...clauses)));
}

/** Remove one edge by id. */
export async function deleteFollowById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(federatedFollows).where(eq(federatedFollows.id, id));
}

/**
 * Remove several edges by id.
 *
 * Id-scoped on purpose: the sharing-off cleanup reads the rows it intends to
 * unwind, bridges each one, and only then deletes. A predicate-scoped delete
 * would also sweep up a fresh inbound Follow that arrived between the read and
 * the delete — a follower silently lost to a race with the toggle.
 */
export async function deleteFollowsByIds(
  ids: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await db
    .delete(federatedFollows)
    .where(inArray(federatedFollows.id, [...ids]))
    .returning({ id: federatedFollows.id });
  return deleted.length;
}

/** Remove the edge identified by the unique triple, if it exists. */
export async function deleteFollow(
  localUserId: string,
  remoteActorUri: string,
  direction: FollowDirection,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .delete(federatedFollows)
    .where(
      and(
        eq(federatedFollows.localUserId, localUserId),
        eq(federatedFollows.remoteActorUri, remoteActorUri),
        eq(federatedFollows.direction, direction),
      ),
    );
}

/** Remove every edge naming a local user or a remote actor — the purge scripts. */
export async function deleteFollowsFor(
  filter: { localUserId?: string; remoteActorUri?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const clauses: SQL[] = [];
  if (filter.localUserId !== undefined) clauses.push(eq(federatedFollows.localUserId, filter.localUserId));
  if (filter.remoteActorUri !== undefined) {
    clauses.push(eq(federatedFollows.remoteActorUri, filter.remoteActorUri));
  }
  if (clauses.length === 0) return 0;

  const deleted = await db
    .delete(federatedFollows)
    .where(or(...clauses))
    .returning({ id: federatedFollows.id });
  return deleted.length;
}
