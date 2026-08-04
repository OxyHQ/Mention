/**
 * The write path for `feed_generators` mirrored from an external network.
 *
 * ## The split this closes, and which way its false answer pointed
 *
 * `FeedGeneratorFeed.isAtprotoBacked()` already read `feed_generators` from
 * Postgres while `connectors/atproto/feedgen.mapper.ts` still wrote the Mongoose
 * model — two self-consistent halves that never met. The reader's miss is not an
 * error: it logs `no atproto-backed generator for descriptor` at INFO and serves
 * an EMPTY page, because a stale `feedgen|<uri>` link must never break the feed
 * engine. So every mirrored Bluesky feed resolved to nothing, on a request path,
 * with the only evidence an info-level line nobody greps for.
 *
 * The observer is a person who opened the feed, which is what makes this a
 * repository rather than something that throws — but the direction is worth
 * stating: an unwritten generator is indistinguishable from a generator that
 * genuinely is not atproto-backed.
 */

import { eq, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { feedGenerators } from '../schema/feeds';

/** One mirrored generator, as the atproto mapper normalizes it. */
export interface AtprotoFeedGeneratorInput {
  /** The generator's AT-URI — the dedup key and the `feedgen|<uri>` descriptor id. */
  uri: string;
  name: string;
  description?: string;
  avatar?: string;
  /** The DID of the remote service that RUNS the ranking. */
  serviceDid: string;
  likeCount: number;
  /** The resolved federated Oxy user the generator is owned by. */
  ownerOxyUserId: string;
}

/**
 * Upsert one mirrored generator on its AT-URI.
 *
 * `subscriber_count` is deliberately absent from the conflict update: it is
 * Mention's own number, not the remote service's, and re-syncing metadata must
 * not reset it. `description` and `avatar` ARE written as NULL when the remote
 * view no longer carries them — Mongoose dropped `undefined` keys from an update,
 * so a description deleted upstream survived here forever; a mirror that cannot
 * un-set a field is not mirroring it.
 */
export async function upsertAtprotoFeedGenerator(
  generator: AtprotoFeedGeneratorInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const values = {
    uri: generator.uri,
    name: generator.name,
    description: generator.description ?? null,
    avatar: generator.avatar ?? null,
    // `algorithm` is a required human-readable marker; `source_network` is the
    // authoritative "atproto-backed" flag the feed engine reads.
    algorithm: 'atproto',
    createdBy: generator.ownerOxyUserId,
    likeCount: generator.likeCount,
    sourceNetwork: 'atproto',
    sourceServiceDid: generator.serviceDid,
    sourceSyncedAt: new Date(),
  } as const;

  await db
    .insert(feedGenerators)
    .values(values)
    .onConflictDoUpdate({
      target: feedGenerators.uri,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        avatar: sql`excluded.avatar`,
        algorithm: sql`excluded.algorithm`,
        createdBy: sql`excluded.created_by`,
        likeCount: sql`excluded.like_count`,
        sourceNetwork: sql`excluded.source_network`,
        sourceServiceDid: sql`excluded.source_service_did`,
        sourceSyncedAt: sql`excluded.source_synced_at`,
        updatedAt: new Date(),
      },
    });
}

/** One generator by AT-URI, or `null`. */
export async function loadFeedGeneratorByUri(
  uri: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<typeof feedGenerators.$inferSelect | null> {
  const [row] = await db.select().from(feedGenerators).where(eq(feedGenerators.uri, uri)).limit(1);
  return row ?? null;
}
