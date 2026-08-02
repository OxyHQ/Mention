/**
 * Real `federated_actors` / `federated_follows` rows for the federation suites.
 *
 * These suites used to mock the Mongoose models, which meant every assertion
 * about an actor or a follow edge was an assertion about the mock: a test could
 * say "the inbound Follow was recorded" while the only thing it observed was
 * that `findOneAndUpdate` had been CALLED. Both tables are Postgres now, so the
 * rows are real and the assertions are about rows.
 *
 * ## Every fixture is namespaced, because vitest runs files in parallel
 *
 * One database serves the whole run, so a suite that deleted "all actors" in its
 * teardown would delete another file's rows mid-test. {@link federationScope}
 * derives a per-file prefix and every helper builds its identifiers from it, so
 * a suite's cleanup is `LIKE '<prefix>%'` and can only ever reach its own rows.
 * The scope is passed in rather than inferred so it is visible in the suite that
 * owns it — an inferred one silently collides when two files pick the same name.
 */

import { eq, inArray, like, or } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { federatedActorFields, federatedActors, federatedFollows } from '../../db/schema/federation';
import { assembleActorRecord } from '../../db/federation/actorRepository';
import type { FederatedActorRecord } from '../../db/federation/actorRecord';

type ActorInsert = typeof federatedActors.$inferInsert;
type FollowInsert = typeof federatedFollows.$inferInsert;

/**
 * Every actor URI a scope has seeded, so cleanup reaches rows a suite placed
 * OUTSIDE its own origin.
 *
 * A prefix match on the scope's origin covers the common case, but several
 * suites legitimately seed an actor at a real third-party host — `bsky.brid.gy`
 * for the bridge derivation, `mastodon.online` for the "unchanged actorUri
 * path". Those rows are invisible to a prefix-scoped delete and leak into the
 * next test in the file, where they answer a lookup that was supposed to find
 * nothing. Recording the URI is the only scoping that survives a suite choosing
 * its own hostnames.
 */
const seededUris = new Map<string, Set<string>>();

function recordSeeded(scope: FederationScope, uri: string): void {
  const existing = seededUris.get(scope.origin);
  if (existing) existing.add(uri);
  else seededUris.set(scope.origin, new Set([uri]));
}

/** A suite's private namespace for the rows it creates. */
export interface FederationScope {
  /** `https://<name>.test` — every seeded actor URI starts with this. */
  readonly origin: string;
  /** `<name>.test` — the instance domain seeded actors belong to. */
  readonly domain: string;
  /** A local Oxy user id unique to this suite. */
  readonly localUserId: string;
  /**
   * A NAMED local Oxy user id, unique to this suite.
   *
   * Sender ids have to be namespaced for the same reason actor URIs do, and it
   * is easier to forget: two suites that both seed a follower for `'author-oxy'`
   * see each other's follower inboxes in one fan-out, because the follow table
   * is keyed by that id and the run is parallel. This is not hypothetical — it
   * happened between the update- and delete-federation suites during this port,
   * and the symptom was a second, unexplained inbox in a delivery assertion.
   */
  user(name: string): string;
}

/**
 * Build a suite's namespace.
 *
 * @param name A short, file-unique slug (`'inbound-follow-bridge'`). It becomes
 *   part of a hostname, so it must be DNS-shaped — the actor URIs seeded from it
 *   are parsed by the production code under test.
 */
export function federationScope(name: string): FederationScope {
  return {
    origin: `https://${name}.test`,
    domain: `${name}.test`,
    localUserId: `oxy-local-${name}`,
    user: (local: string) => `oxy-${local}-${name}`,
  };
}

/** What a seeded actor overrides. `uri`/`acct` default to the scope's namespace. */
export interface SeedActorOptions extends Partial<Omit<ActorInsert, 'id'>> {
  /** The local part of the seeded actor's handle. Defaults to `'remote'`. */
  username?: string;
}

/**
 * Insert one federated actor and return it as the record production code reads.
 *
 * The defaults describe a healthy, resolved, ActivityPub actor with an inbox —
 * the shape almost every federation path expects — so a suite only states the
 * field it is actually about.
 */
export async function seedActor(
  scope: FederationScope,
  options: SeedActorOptions = {},
): Promise<FederatedActorRecord> {
  const username = options.username ?? 'remote';
  const uri = options.uri ?? `${scope.origin}/users/${username}`;
  const [row] = await getDb()
    .insert(federatedActors)
    .values({
      protocol: 'activitypub',
      uri,
      username,
      domain: scope.domain,
      acct: `${username}@${scope.domain}`,
      inboxUrl: `${uri}/inbox`,
      outboxUrl: `${uri}/outbox`,
      type: 'Person',
      lastFetchedAt: new Date(),
      ...options,
    })
    .returning();
  recordSeeded(scope, row.uri);
  return assembleActorRecord(row);
}

/** Insert the verified-links rows of an actor, in order. */
export async function seedActorFields(
  actorId: string,
  fields: ReadonlyArray<{ name: string; value: string; verifiedAt?: Date }>,
): Promise<void> {
  if (fields.length === 0) return;
  await getDb()
    .insert(federatedActorFields)
    .values(
      fields.map((field, position) => ({
        actorId,
        position,
        name: field.name,
        value: field.value,
        verifiedAt: field.verifiedAt ?? null,
      })),
    );
}

/** Insert one follow edge. `localUserId` defaults to the scope's local user. */
export async function seedFollow(
  scope: FederationScope,
  options: Partial<Omit<FollowInsert, 'id'>> & { remoteActorUri: string },
): Promise<string> {
  const [row] = await getDb()
    .insert(federatedFollows)
    .values({
      localUserId: scope.localUserId,
      direction: 'inbound',
      status: 'accepted',
      network: 'activitypub',
      ...options,
    })
    .returning({ id: federatedFollows.id });
  return row.id;
}

/**
 * One accepted FOLLOWER of a local user, with an inbox — the fixture every
 * outbound fan-out test needs.
 *
 * Seeds both halves because `deliverToFollowers` reads them in two steps: the
 * accepted inbound follow edges give it actor URIs, and the actor rows give it
 * the inboxes. Mocking only one half is how a suite ends up asserting that a
 * fan-out reached an inbox that no follower actually advertises.
 *
 * @returns the inbox URL the fan-out should reach.
 */
export async function seedFollowerWithInbox(
  scope: FederationScope,
  localUserId: string,
  options: { username?: string; sharedInbox?: boolean } = {},
): Promise<string> {
  const username = options.username ?? 'follower';
  const uri = `${scope.origin}/users/${username}`;
  const inbox = `${scope.origin}/inbox/${username}`;
  await seedActor(scope, {
    username,
    uri,
    inboxUrl: inbox,
    // A shared inbox is preferred over the personal one by the fan-out's dedup,
    // so which of the two carries the URL is part of what a suite may be pinning.
    sharedInboxUrl: options.sharedInbox === false ? null : inbox,
  });
  await seedFollow(scope, {
    localUserId,
    remoteActorUri: uri,
    direction: 'inbound',
    status: 'accepted',
  });
  return inbox;
}

/** Every follow edge a suite created, for asserting what a handler wrote. */
export async function readFollows(
  scope: FederationScope,
): Promise<Array<typeof federatedFollows.$inferSelect>> {
  return getDb()
    .select()
    .from(federatedFollows)
    .where(
      or(
        eq(federatedFollows.localUserId, scope.localUserId),
        like(federatedFollows.remoteActorUri, `${scope.origin}%`),
      ),
    );
}

/** One actor as it is stored right now, for asserting what a handler wrote. */
export async function readActor(uri: string): Promise<FederatedActorRecord | null> {
  const [row] = await getDb().select().from(federatedActors).where(eq(federatedActors.uri, uri));
  return row ? assembleActorRecord(row) : null;
}

/**
 * Remove everything a suite created — and ONLY that.
 *
 * Scoped by the suite's own URI prefix and local user id rather than truncating,
 * because the run is parallel: a `DELETE FROM federated_actors` here would pull
 * the rows out from under whichever other file is mid-assertion. `federated_actor_fields`
 * goes with its actor by `ON DELETE CASCADE`.
 */
export async function clearFederationScope(
  scope: FederationScope,
  extraActorUris: readonly string[] = [],
): Promise<void> {
  const db = getDb();
  // EITHER identifier, because a suite's rows are reachable by two different
  // handles: its own sender ids (which carry the scope name) and the remote
  // actors it seeded (which carry the scope origin). A follow to an atproto DID
  // matches only the first; a follow written by another of the suite's users
  // matches only the second.
  await db
    .delete(federatedFollows)
    .where(
      or(
        like(federatedFollows.localUserId, `%${scope.domain.replace('.test', '')}`),
        eq(federatedFollows.localUserId, scope.localUserId),
        like(federatedFollows.remoteActorUri, `${scope.origin}%`),
      ),
    );
  // `extraActorUris` covers rows written by the PRODUCTION code under test
  // rather than by `seedActor` — an upsert the suite triggered, whose URI and
  // domain it does not control.
  const tracked = seededUris.get(scope.origin);
  const uris = [...(tracked ?? []), ...extraActorUris];
  await db
    .delete(federatedActors)
    .where(
      or(
        like(federatedActors.uri, `${scope.origin}%`),
        eq(federatedActors.domain, scope.domain),
        ...(uris.length > 0 ? [inArray(federatedActors.uri, uris)] : []),
      ),
    );
  tracked?.clear();
}
