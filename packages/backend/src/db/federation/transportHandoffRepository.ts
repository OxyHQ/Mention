import { and, eq, inArray, lt, min, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  federatedActors,
  federatedFollows,
  federatedTransportHandoffs,
} from '../schema/federation';
import { posts } from '../schema/posts';

/** An account's stored handoff: `at` is null when the keyed transport is its only source. */
export interface TransportHandoff {
  at: Date | null;
}

/** The stored handoff of `networkAcct`, or undefined when none was written. */
export async function findTransportHandoff(
  networkAcct: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TransportHandoff | undefined> {
  const [row] = await db
    .select({ at: federatedTransportHandoffs.handoffAt })
    .from(federatedTransportHandoffs)
    .where(eq(federatedTransportHandoffs.networkAcct, networkAcct))
    .limit(1);
  return row ? { at: row.at } : undefined;
}

/**
 * When Mention first held an accepted follow of one of `keyedHosts` for
 * `networkAcct` (the Accept's write time), or null when it holds none.
 */
export async function firstAcceptedKeyedFollowAt(
  networkAcct: string,
  keyedHosts: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Date | null> {
  if (keyedHosts.length === 0) return null;
  const [row] = await db
    .select({ at: min(federatedFollows.updatedAt) })
    .from(federatedFollows)
    .innerJoin(federatedActors, eq(federatedActors.uri, federatedFollows.remoteActorUri))
    .where(
      and(
        eq(federatedActors.networkAcct, networkAcct),
        inArray(federatedActors.domain, [...keyedHosts]),
        eq(federatedFollows.direction, 'outbound'),
        eq(federatedFollows.status, 'accepted'),
      ),
    );
  return row?.at ?? null;
}

/** Whether Mention holds a post from one of `keylessHosts` for `networkAcct` published before `before`. */
export async function holdsKeylessPostBefore(
  networkAcct: string,
  keylessHosts: readonly string[],
  before: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  if (keylessHosts.length === 0) return false;
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(posts)
    .innerJoin(federatedActors, eq(federatedActors.uri, posts.federationActorUri))
    .where(
      and(
        eq(federatedActors.networkAcct, networkAcct),
        inArray(federatedActors.domain, [...keylessHosts]),
        lt(posts.createdAt, before),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Write `networkAcct`'s handoff unless one exists, and return the stored one —
 * the first writer wins, so concurrent ingests agree and the instant never moves.
 */
export async function writeTransportHandoffOnce(
  networkAcct: string,
  at: Date | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<TransportHandoff> {
  await db
    .insert(federatedTransportHandoffs)
    .values({ networkAcct, handoffAt: at })
    .onConflictDoNothing({ target: federatedTransportHandoffs.networkAcct });
  return (await findTransportHandoff(networkAcct, db)) ?? { at };
}
