/**
 * The ONLY module that knows a federated actor is two tables and a dozen flat
 * `outbox_backfill_*` columns.
 *
 * Everything above it — the `@oxyhq/federation` actor resolver's store adapter,
 * the delivery service, the follow/inbox/outbox services, the profile-sync job,
 * hydration, the feed controllers and the maintenance scripts — reads and writes
 * a whole {@link FederatedActorRecord}.
 *
 * ## Three traps this module is written against
 *
 * 1. **`$ne` against a possibly-absent value.** Mongo's `$ne` MATCHES a missing
 *    field and its `$expr: { $ne: [a, b] }` treats a missing `a` as null, so
 *    `{ $expr: { $ne: ['$outboxBackfill.outboxUrl', '$outboxUrl'] } }` selected
 *    every actor that had never been backfilled. SQL's `<>` yields NULL — not
 *    true — the moment either side is NULL, so the direct translation drops
 *    exactly the rows the predicate exists to find. Every such comparison below
 *    uses `IS DISTINCT FROM` / `IS NOT TRUE`, which are total.
 * 2. **NULL ordering is REVERSED between the two.** Mongo sorts a missing value
 *    FIRST on an ascending sort; Postgres sorts NULLs LAST. The backfill claim
 *    orders by `outbox_backfill_last_run_at ASC` precisely so an actor that has
 *    never run is picked first, so it must say `NULLS FIRST` explicitly or the
 *    never-run actors are served last — starved behind every actor that has run
 *    at least once.
 * 3. **Drizzle keys `set()` by column PROPERTY and silently ignores an unknown
 *    key.** The Mongo writes this replaces were dot-path updates
 *    (`'outboxBackfill.status'`), and a leftover dot path handed to `set()`
 *    updates nothing and throws nothing — an outbox marked permanently
 *    unavailable would be re-fetched forever. Every write below builds a typed
 *    `Partial<typeof federatedActors.$inferInsert>`, so a stale property name
 *    fails `tsc` instead of writing nothing.
 *
 * A note on shape: an optional field is assembled as a PRESENT key holding
 * `undefined` rather than being omitted. Nothing here reaches a wire contract
 * (`JSON.stringify` drops `undefined`) or a Mongo update document, and every
 * reader is a property access, so the distinction is unobservable and the
 * assembly stays one flat object literal instead of fifteen conditional spreads.
 */

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { federatedActorFields, federatedActors } from '../schema/federation';
import type {
  FederatedActorField,
  FederatedActorRecord,
  FederatedOutboxBackfillState,
} from './actorRecord';

type ActorRow = typeof federatedActors.$inferSelect;
type ActorInsert = typeof federatedActors.$inferInsert;

/** `null` (what a nullable column reads as) → `undefined` (what the record carries). */
function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/** Rebuild the backfill cursor + counters from their flat columns. */
function assembleOutboxBackfill(row: ActorRow): FederatedOutboxBackfillState {
  return {
    status: optional(row.outboxBackfillStatus),
    outboxUrl: optional(row.outboxBackfillOutboxUrl),
    cursorUrl: optional(row.outboxBackfillCursorUrl),
    cursorItemOffset: row.outboxBackfillCursorItemOffset,
    processedCount: row.outboxBackfillProcessedCount,
    importedCount: row.outboxBackfillImportedCount,
    existingCount: row.outboxBackfillExistingCount,
    pageCount: row.outboxBackfillPageCount,
    lockedUntil: optional(row.outboxBackfillLockedUntil),
    lastRunAt: optional(row.outboxBackfillLastRunAt),
    completedAt: optional(row.outboxBackfillCompletedAt),
    lastError: optional(row.outboxBackfillLastError),
  };
}

/** Turn one `federated_actors` row into the record consumers read. */
export function assembleActorRecord(row: ActorRow): FederatedActorRecord {
  return {
    id: row.id,
    protocol: row.protocol,
    uri: row.uri,
    username: row.username,
    domain: row.domain,
    acct: row.acct,
    networkAcct: optional(row.networkAcct),
    summary: optional(row.summary),
    avatarUrl: optional(row.avatarUrl),
    headerUrl: optional(row.headerUrl),
    inboxUrl: optional(row.inboxUrl),
    outboxUrl: optional(row.outboxUrl),
    sharedInboxUrl: optional(row.sharedInboxUrl),
    followersUrl: optional(row.followersUrl),
    followingUrl: optional(row.followingUrl),
    publicKeyPem: optional(row.publicKeyPem),
    publicKeyId: optional(row.publicKeyId),
    type: row.type,
    manuallyApprovesFollowers: row.manuallyApprovesFollowers,
    discoverable: row.discoverable,
    memorial: row.memorial,
    suspended: row.suspended,
    featuredUrl: optional(row.featuredUrl),
    featuredTagsUrl: optional(row.featuredTagsUrl),
    alsoKnownAs: optional(row.alsoKnownAs),
    remoteCreatedAt: optional(row.remoteCreatedAt),
    followersCount: row.followersCount,
    followingCount: row.followingCount,
    postsCount: row.postsCount,
    oxyUserId: optional(row.oxyUserId),
    lastFetchedAt: optional(row.lastFetchedAt),
    lastOutboxSyncAt: optional(row.lastOutboxSyncAt),
    outboxBackfill: assembleOutboxBackfill(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Load one actor by its protocol URI (AP actor URI, or atproto DID). */
export async function findActorByUri(
  uri: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord | null> {
  const [row] = await db.select().from(federatedActors).where(eq(federatedActors.uri, uri)).limit(1);
  return row ? assembleActorRecord(row) : null;
}

/**
 * Load one actor by the Oxy account minted for it.
 *
 * `federated_actors.oxy_user_id` is NOT unique — a re-resolved actor can leave a
 * second row pointing at the same Oxy account — so this returns the most recently
 * fetched one, which is the row the resolver has been keeping current. Mongo's
 * `findOne` returned whatever the index scan reached first, which is the same
 * question answered arbitrarily rather than deliberately.
 */
export async function findActorByOxyUserId(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord | null> {
  const [row] = await db
    .select()
    .from(federatedActors)
    .where(eq(federatedActors.oxyUserId, oxyUserId))
    .orderBy(sql`${federatedActors.lastFetchedAt} desc nulls last`, desc(federatedActors.id))
    .limit(1);
  return row ? assembleActorRecord(row) : null;
}

/** Load one actor by its `publicKey.id` — the HTTP-signature key resolution. */
export async function findActorByPublicKeyId(
  keyId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord | null> {
  const [row] = await db
    .select()
    .from(federatedActors)
    .where(eq(federatedActors.publicKeyId, keyId))
    .limit(1);
  return row ? assembleActorRecord(row) : null;
}

/** Load actors by protocol URI. Returns only the ones that exist, in no particular order. */
export async function findActorsByUris(
  uris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord[]> {
  if (uris.length === 0) return [];
  const rows = await db
    .select()
    .from(federatedActors)
    .where(inArray(federatedActors.uri, [...uris]));
  return rows.map(assembleActorRecord);
}

/**
 * Just the two inbox columns, for a set of actor URIs — the follower fan-out.
 *
 * Projected rather than assembled: this runs once per outbound activity with one
 * URI per accepted follower, and every other column (the bio, the profile URLs,
 * the whole backfill cursor) would be read and discarded on a path whose entire
 * job is picking a URL to POST to.
 */
export async function findActorInboxesByUris(
  uris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Array<{ sharedInboxUrl?: string; inboxUrl?: string }>> {
  if (uris.length === 0) return [];
  const rows = await db
    .select({
      sharedInboxUrl: federatedActors.sharedInboxUrl,
      inboxUrl: federatedActors.inboxUrl,
    })
    .from(federatedActors)
    .where(inArray(federatedActors.uri, [...uris]));
  return rows.map((row) => ({
    sharedInboxUrl: optional(row.sharedInboxUrl),
    inboxUrl: optional(row.inboxUrl),
  }));
}

/** Load actors by the Oxy accounts minted for them. */
export async function findActorsByOxyUserIds(
  oxyUserIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord[]> {
  if (oxyUserIds.length === 0) return [];
  const rows = await db
    .select()
    .from(federatedActors)
    .where(inArray(federatedActors.oxyUserId, [...oxyUserIds]));
  return rows.map(assembleActorRecord);
}

/**
 * Load one actor by EITHER its canonical URI or its webfinger acct.
 *
 * The follow route accepts whichever spelling the client had, so the lookup has
 * to try both before deciding the stored row does not exist.
 */
export async function findActorByUriOrAcct(
  value: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord | null> {
  const [row] = await db
    .select()
    .from(federatedActors)
    .where(or(eq(federatedActors.uri, value), eq(federatedActors.acct, value)))
    .limit(1);
  return row ? assembleActorRecord(row) : null;
}

/** Load one actor by its webfinger acct (`user@domain`). */
export async function findActorByAcct(
  acct: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord | null> {
  const [row] = await db
    .select()
    .from(federatedActors)
    .where(eq(federatedActors.acct, acct))
    .limit(1);
  return row ? assembleActorRecord(row) : null;
}

/** The three columns the duplicate-identity merge decides on. */
export interface IdentityOwnerActor {
  uri: string;
  domain: string;
  oxyUserId: string;
}

/**
 * The OTHER actor row that already holds `federatedUsername` as its identity, if
 * one exists — the lookup behind `resolveFederatedActorIdentity`'s merge.
 *
 * Two shapes have to match or the merge cannot see across them, and the pair it
 * most needs to see across is a Bluesky account held NATIVELY over atproto and
 * AGAIN over ActivityPub through a bridge:
 *
 * - a BRIDGED row carries the identity explicitly in `network_acct`;
 * - every other row's identity IS `username@domain`, which is how the atproto
 *   connector stores a Bluesky account without ever writing `network_acct`.
 *
 * `network_acct is null` is the faithful translation of Mongo's
 * `{ $exists: false }` here because {@link upsertActor} writes the column as NULL
 * when the caller has no value — absent and null are the same state by
 * construction, so there is no third case to miss.
 *
 * `uri <> :uri` is total: `uri` is `NOT NULL`, so the comparison can never
 * evaluate to NULL and silently drop the row it is meant to exclude. `oxy_user_id
 * is not null` is the whole of Mongo's `{ $exists: true, $ne: null }` — a row
 * with no Oxy user has no identity to lend.
 */
export async function findIdentityOwnerActor(
  params: { federatedUsername: string; excludeUri: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<IdentityOwnerActor | null> {
  const atIndex = params.federatedUsername.indexOf('@');
  const shapes: SQL[] = [eq(federatedActors.networkAcct, params.federatedUsername)];
  if (atIndex > 0 && atIndex < params.federatedUsername.length - 1) {
    shapes.push(
      and(
        isNull(federatedActors.networkAcct),
        eq(federatedActors.username, params.federatedUsername.slice(0, atIndex)),
        eq(federatedActors.domain, params.federatedUsername.slice(atIndex + 1)),
      ) as SQL,
    );
  }

  const [row] = await db
    .select({
      uri: federatedActors.uri,
      domain: federatedActors.domain,
      oxyUserId: federatedActors.oxyUserId,
    })
    .from(federatedActors)
    .where(and(
      or(...shapes),
      ne(federatedActors.uri, params.excludeUri),
      isNotNull(federatedActors.oxyUserId),
    ))
    .limit(1);

  // `oxy_user_id` is nullable on the column but `IS NOT NULL` above has already
  // decided it; narrow rather than assert so the type follows the predicate.
  if (!row || row.oxyUserId === null) return null;
  return { uri: row.uri, domain: row.domain, oxyUserId: row.oxyUserId };
}

/** What a maintenance sweep narrows its scan to. Every field is ANDed. */
export interface ActorScanFilter {
  protocol?: FederatedActorRecord['protocol'];
  /**
   * Every protocol EXCEPT this one.
   *
   * Mongo's `{ protocol: { $ne: 'atproto' } }` also matched a row with NO
   * `protocol` at all, which was the point — pre-atproto rows had none. The
   * column is `NOT NULL DEFAULT 'activitypub'`, so `<> 'atproto'` is total here
   * and covers that population; the `$ne`/`<>` asymmetry that bites elsewhere in
   * this file does not, because there is no NULL to swallow the comparison.
   */
  protocolNot?: FederatedActorRecord['protocol'];
  /** Actors that advertise a banner (a non-empty `header_url`). */
  hasHeaderUrl?: boolean;
  /** Actors linked to an Oxy account (a non-empty `oxy_user_id`). */
  hasOxyUserId?: boolean;
  suspended?: boolean;
  /**
   * Actors the remote reports as having no posts.
   *
   * The Mongo filter was `$or: [{postsCount: 0}, {postsCount: {$exists: false}}]`;
   * `posts_count` is `NOT NULL DEFAULT 0`, so the second branch has no Postgres
   * counterpart and `= 0` covers both.
   */
  zeroPostsCount?: boolean;
  /** Narrow to ONE actor by its canonical protocol URI. */
  uri?: string;
  /** Narrow to ONE actor, matched on either spelling of its identifier. */
  uriOrAcct?: string;
}

function scanClauses(filter: ActorScanFilter): SQL[] {
  const clauses: SQL[] = [];
  if (filter.protocol !== undefined) clauses.push(eq(federatedActors.protocol, filter.protocol));
  if (filter.protocolNot !== undefined) clauses.push(ne(federatedActors.protocol, filter.protocolNot));
  if (filter.suspended !== undefined) clauses.push(eq(federatedActors.suspended, filter.suspended));
  if (filter.zeroPostsCount) clauses.push(eq(federatedActors.postsCount, 0));
  if (filter.uri !== undefined) clauses.push(eq(federatedActors.uri, filter.uri));
  // `{ $type: 'string', $ne: '' }` — present, a string, and not empty. `IS NOT
  // NULL` covers the first two (the column is `text`, so a present value IS a
  // string), and the `<> ''` is only reachable once the NULL is excluded, which
  // is why the two are written in this order rather than as one comparison.
  if (filter.hasHeaderUrl) {
    clauses.push(and(isNotNull(federatedActors.headerUrl), ne(federatedActors.headerUrl, ''))!);
  }
  if (filter.hasOxyUserId) {
    clauses.push(and(isNotNull(federatedActors.oxyUserId), ne(federatedActors.oxyUserId, ''))!);
  }
  if (filter.uriOrAcct !== undefined) {
    clauses.push(or(eq(federatedActors.uri, filter.uriOrAcct), eq(federatedActors.acct, filter.uriOrAcct))!);
  }
  return clauses;
}

/** How many actors a scan will visit. */
export async function countActors(
  filter: ActorScanFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const clauses = scanClauses(filter);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(federatedActors)
    .where(clauses.length > 0 ? and(...clauses) : undefined);
  return row?.count ?? 0;
}

/**
 * One page of a full scan, keyed on `id`.
 *
 * `ORDER BY id ASC` is correct here and is NOT the chronological-ordering trap
 * the schema conventions warn about. The primary key is `text` holding a 24-char
 * ObjectId hex for pre-cutover rows and a uuid v7 for later ones, so `id` order
 * is not TIME order — but a sweep does not want time order, it wants a stable
 * TOTAL order so its cursor can neither revisit nor skip a row, and lexicographic
 * order over a text primary key is exactly that. A query that needs chronology
 * must order by a timestamp column instead.
 */
export async function scanActors(
  filter: ActorScanFilter,
  page: { afterId?: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord[]> {
  const clauses = scanClauses(filter);
  if (page.afterId !== undefined) clauses.push(gt(federatedActors.id, page.afterId));

  const rows = await db
    .select()
    .from(federatedActors)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(asc(federatedActors.id))
    .limit(page.limit);
  return rows.map(assembleActorRecord);
}

/** The verified-links rows of one actor, in the order the remote profile lists them. */
export async function loadActorFields(
  actorId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorField[]> {
  const rows = await db
    .select()
    .from(federatedActorFields)
    .where(eq(federatedActorFields.actorId, actorId))
    .orderBy(asc(federatedActorFields.position));
  return rows.map((row) => ({
    name: row.name,
    value: row.value,
    verifiedAt: optional(row.verifiedAt),
  }));
}

/**
 * The ActivityPub actor types the schema's CHECK constraint admits, and the one
 * anything else becomes.
 *
 * This narrowing has to happen, and it is the one place the port is not
 * behaviour-preserving — deliberately, because the alternative is worse. Mongoose
 * declared the same enum but `findOneAndUpdate` does not run validators, so the
 * upsert stored whatever string the remote sent: `type: "Bot"`, `"Hubzilla"`,
 * anything. `federated_actors_type_check` rejects those, and a rejected upsert
 * fails `fetchRemoteActor`, which means the actor never resolves, no inbound
 * activity from that instance can ever be attributed, and the only symptom is
 * federation quietly not working with that server.
 *
 * `'Person'` is the schema default and what every consumer already treats an
 * unrecognized actor as — the Stage-A classifier's bot signal is the only reader
 * of `type` at all, and it tests for the specific types it knows.
 *
 * **The information is lost, and the backfill's enum audit is where it surfaces.**
 * Every remote type outside this set becomes `Person` from here on, so the audit
 * that runs against production before the cutover is the ONE place the real
 * distribution appears — a `Hubzilla` or a `Bot` in that report is this decision,
 * not an oversight, and does not need re-investigating.
 */
const ACTOR_TYPES: ReadonlySet<string> = new Set<FederatedActorRecord['type']>([
  'Person',
  'Service',
  'Application',
  'Group',
  'Organization',
]);

function normalizeActorType(type: string): FederatedActorRecord['type'] {
  return ACTOR_TYPES.has(type) ? (type as FederatedActorRecord['type']) : 'Person';
}

/** Every column the actor resolver's upsert writes, minus the `fields` table. */
export interface ActorUpsertColumns {
  protocol: FederatedActorRecord['protocol'];
  username: string;
  domain: string;
  acct: string;
  /**
   * Only a BRIDGED actor carries one. Absent means "not bridged", and the upsert
   * writes it as NULL for exactly that reason: a row that STOPPED being bridged
   * — a bridge dropped from the policy, or an actor that no longer satisfies its
   * rule — must not keep claiming an identity it no longer derives.
   */
  networkAcct?: string;
  summary?: string;
  avatarUrl?: string;
  headerUrl?: string;
  inboxUrl?: string;
  outboxUrl?: string;
  sharedInboxUrl?: string;
  followersUrl?: string;
  followingUrl?: string;
  publicKeyPem?: string;
  publicKeyId?: string;
  /** Free-form as the remote sent it; narrowed by {@link normalizeActorType}. */
  type: string;
  manuallyApprovesFollowers: boolean;
  discoverable: boolean;
  memorial: boolean;
  suspended: boolean;
  featuredUrl?: string;
  featuredTagsUrl?: string;
  alsoKnownAs?: string[];
  remoteCreatedAt?: Date;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  lastFetchedAt: Date;
}

/**
 * Create-or-update the actor cache row keyed by `uri`, replacing its verified
 * links, and return the whole record.
 *
 * `ON CONFLICT (uri) DO UPDATE` rather than a read-then-branch, so two inbound
 * activities from the same first-seen actor cannot both decide to insert.
 *
 * The fields table is delete-then-insert inside the same transaction: it carries
 * `UNIQUE (actor_id, position)`, so a profile that REORDERED its links collides
 * with itself mid-update unless the old rows are gone first. Passing an empty
 * list therefore CLEARS the links, which is what a profile that removed all of
 * them means — matching the `$set: { fields: [...] }` it replaces.
 *
 * Mongo's counterpart threw a duplicate-key error when a DIFFERENT uri already
 * held this `acct` (or `(domain, username)`); the unique constraints here raise
 * the same way, and the actor resolver's caller treats it as a failed resolution.
 * That is deliberate — silently taking the handle from another row would let one
 * remote instance hijack another's cached identity.
 */
export async function upsertActor(
  uri: string,
  columns: ActorUpsertColumns,
  fields: readonly FederatedActorField[],
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedActorRecord | null> {
  // `null`, not `undefined`: drizzle SKIPS an `undefined` property in `set()`,
  // so an absent value would LEAVE the previous one in place. A remote that
  // removed its header image, its featured collection or its public key must end
  // up with the column cleared, not with a stale value that outlives the change.
  const values = {
    protocol: columns.protocol,
    uri,
    username: columns.username,
    domain: columns.domain,
    acct: columns.acct,
    networkAcct: columns.networkAcct ?? null,
    summary: columns.summary ?? null,
    avatarUrl: columns.avatarUrl ?? null,
    headerUrl: columns.headerUrl ?? null,
    inboxUrl: columns.inboxUrl ?? null,
    outboxUrl: columns.outboxUrl ?? null,
    sharedInboxUrl: columns.sharedInboxUrl ?? null,
    followersUrl: columns.followersUrl ?? null,
    followingUrl: columns.followingUrl ?? null,
    publicKeyPem: columns.publicKeyPem ?? null,
    publicKeyId: columns.publicKeyId ?? null,
    type: normalizeActorType(columns.type),
    manuallyApprovesFollowers: columns.manuallyApprovesFollowers,
    discoverable: columns.discoverable,
    memorial: columns.memorial,
    suspended: columns.suspended,
    featuredUrl: columns.featuredUrl ?? null,
    featuredTagsUrl: columns.featuredTagsUrl ?? null,
    alsoKnownAs: columns.alsoKnownAs ?? null,
    remoteCreatedAt: columns.remoteCreatedAt ?? null,
    followersCount: columns.followersCount,
    followingCount: columns.followingCount,
    postsCount: columns.postsCount,
    lastFetchedAt: columns.lastFetchedAt,
  } satisfies ActorInsert;

  const write = async (tx: DatabaseOrTransaction): Promise<ActorRow | undefined> => {
    // `oxy_user_id` is deliberately NOT in either half: it is stamped by
    // `setActorOxyUserId` AFTER the identity bridge resolves, and a refresh that
    // re-wrote it from an upsert payload that never carries it would clear the
    // link on every actor refresh.
    const { uri: _conflictKey, ...updatable } = values;
    const [row] = await tx
      .insert(federatedActors)
      .values(values)
      .onConflictDoUpdate({
        target: federatedActors.uri,
        set: { ...updatable, updatedAt: new Date() },
      })
      .returning();
    if (!row) return undefined;

    await tx.delete(federatedActorFields).where(eq(federatedActorFields.actorId, row.id));
    if (fields.length > 0) {
      await tx.insert(federatedActorFields).values(
        fields.map((field, position) => ({
          actorId: row.id,
          position,
          name: field.name,
          value: field.value,
          verifiedAt: field.verifiedAt ?? null,
        })),
      );
    }
    return row;
  };

  // A caller already inside a transaction passes its handle; a `Transaction` has
  // no `.transaction`, so the nesting is decided by the type rather than a probe.
  const row = 'transaction' in db ? await db.transaction(write) : await write(db);
  return row ? assembleActorRecord(row) : null;
}

/** Stamp the resolved Oxy user id onto an actor row. */
export async function setActorOxyUserId(
  actorId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedActors)
    .set({ oxyUserId, updatedAt: new Date() })
    .where(eq(federatedActors.id, actorId));
}

/**
 * Mark a permanently-gone actor suspended and return the Oxy account it linked
 * to, or `null` when no row matched.
 */
export async function tombstoneActor(
  uri: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ oxyUserId?: string } | null> {
  const [row] = await db
    .update(federatedActors)
    .set({ suspended: true, updatedAt: new Date() })
    .where(eq(federatedActors.uri, uri))
    .returning({ oxyUserId: federatedActors.oxyUserId });
  return row ? { oxyUserId: optional(row.oxyUserId) } : null;
}

/**
 * Record that an actor's outbox is permanently unavailable, and CLEAR
 * `last_outbox_sync_at`.
 *
 * Clearing the cooldown stamp is the whole point of the second half: the stamp is
 * what makes an empty first sync permanent (`AGENTS.md`, "silent sticky
 * outage"), and once the outbox is known unavailable the profile-sync path must
 * stop reporting the feed as `pending` rather than keep waiting on a collection
 * that will never answer.
 */
export async function markOutboxBackfillUnavailable(
  actorId: string,
  outboxUrl: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = new Date();
  await db
    .update(federatedActors)
    .set({
      outboxBackfillStatus: 'unavailable',
      outboxBackfillOutboxUrl: outboxUrl,
      outboxBackfillProcessedCount: 0,
      outboxBackfillImportedCount: 0,
      outboxBackfillExistingCount: 0,
      outboxBackfillPageCount: 0,
      outboxBackfillLastRunAt: now,
      outboxBackfillCompletedAt: now,
      outboxBackfillCursorUrl: null,
      outboxBackfillLockedUntil: null,
      outboxBackfillLastError: null,
      lastOutboxSyncAt: null,
      updatedAt: now,
    })
    .where(eq(federatedActors.id, actorId));
}

/** Stamp "we tried to import this actor's posts just now" — the sync cooldown. */
export async function stampLastOutboxSyncAt(
  actorId: string,
  at: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedActors)
    .set({ lastOutboxSyncAt: at, updatedAt: new Date() })
    .where(eq(federatedActors.id, actorId));
}

/**
 * Claim the atproto profile-graph sync for one actor, at most once per cooldown
 * window across every task.
 *
 * The claim IS the write: a conditional `UPDATE … RETURNING` whose predicate
 * carries the cooldown and the lease, so the row count answers "did I get it".
 * A read-then-write would let several concurrent public profile-feed requests
 * each see a free lease and fan out duplicate starter-pack and feed-resolution
 * jobs — which is the exact cost this exists to bound.
 *
 * `uri` is in the predicate as well as `id`: the caller resolved the DID before
 * awaiting, and an actor re-resolved onto a different identity in between must
 * not have work done under the id the caller still holds.
 *
 * @returns `true` when this caller owns the lease and must release it.
 */
export async function claimAtprotoGraphSync(
  actorId: string,
  uri: string,
  now: Date,
  cooldownCutoff: Date,
  staleLeaseCutoff: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const claimed = await db
    .update(federatedActors)
    .set({ atprotoGraphSyncStartedAt: now, updatedAt: new Date() })
    .where(
      and(
        eq(federatedActors.id, actorId),
        eq(federatedActors.uri, uri),
        eq(federatedActors.protocol, 'atproto'),
        isNotNull(federatedActors.oxyUserId),
        // Cooldown: never run, or last completed long enough ago.
        or(
          isNull(federatedActors.lastAtprotoGraphSyncAt),
          lte(federatedActors.lastAtprotoGraphSyncAt, cooldownCutoff),
        ),
        // Lease: nobody holds it, or the holder died and its lease went stale.
        or(
          isNull(federatedActors.atprotoGraphSyncStartedAt),
          lte(federatedActors.atprotoGraphSyncStartedAt, staleLeaseCutoff),
        ),
      ),
    )
    .returning({ id: federatedActors.id });

  return claimed.length > 0;
}

/**
 * Release the lease taken by {@link claimAtprotoGraphSync}.
 *
 * `heldSince` is in the predicate so a caller whose lease already expired and
 * was re-claimed by somebody else cannot clear the NEW holder's lease on its way
 * out — the late finisher simply writes nothing.
 *
 * `completed: false` releases without stamping the cooldown, so a failed run is
 * retried on the next view rather than sitting out the full window.
 */
export async function releaseAtprotoGraphSync(
  actorId: string,
  heldSince: Date,
  completed: boolean,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedActors)
    .set({
      atprotoGraphSyncStartedAt: null,
      ...(completed ? { lastAtprotoGraphSyncAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(federatedActors.id, actorId),
        eq(federatedActors.atprotoGraphSyncStartedAt, heldSince),
      ),
    );
}

/** A whitespace/markup normalization of one actor's stored remote text. */
export interface ActorTextPatch {
  username?: string;
  summary?: string;
  /** Per-position rewrites of the verified-links table. */
  fields?: ReadonlyArray<{ position: number; name?: string; value?: string }>;
}

/**
 * Rewrite an actor's normalized text, and its links' text, atomically.
 *
 * Addressed by POSITION rather than replacing the links wholesale, for the same
 * reason the Mongo counterpart used `fields.<n>.<key>` dot paths: `verified_at`
 * on an untouched row must survive a normalization pass. A position with no row
 * simply updates nothing.
 *
 * @returns whether anything was written, so a sweep can count rows rather than
 *   statements.
 */
export async function updateActorText(
  actorId: string,
  patch: ActorTextPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const columns: Partial<ActorInsert> = {};
  if (patch.username !== undefined) columns.username = patch.username;
  if (patch.summary !== undefined) columns.summary = patch.summary;
  const fields = patch.fields ?? [];
  if (Object.keys(columns).length === 0 && fields.length === 0) return false;

  const write = async (tx: DatabaseOrTransaction): Promise<void> => {
    if (Object.keys(columns).length > 0) {
      await tx
        .update(federatedActors)
        .set({ ...columns, updatedAt: new Date() })
        .where(eq(federatedActors.id, actorId));
    }
    for (const field of fields) {
      const fieldColumns: Partial<typeof federatedActorFields.$inferInsert> = {};
      if (field.name !== undefined) fieldColumns.name = field.name;
      if (field.value !== undefined) fieldColumns.value = field.value;
      if (Object.keys(fieldColumns).length === 0) continue;
      await tx
        .update(federatedActorFields)
        .set(fieldColumns)
        .where(
          and(
            eq(federatedActorFields.actorId, actorId),
            eq(federatedActorFields.position, field.position),
          ),
        );
    }
  };

  if ('transaction' in db) {
    await db.transaction(write);
  } else {
    await write(db);
  }
  return true;
}

/**
 * Set or clear an actor's tombstone.
 *
 * Separate from {@link tombstoneActor}, which also reports the linked Oxy account
 * so the caller can archive it: this is the plain flag write the purge sweep uses
 * to CLEAR a tombstone when a supposedly-gone actor answers again.
 */
export async function updateActorSuspended(
  actorId: string,
  suspended: boolean,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(federatedActors)
    .set({ suspended, updatedAt: new Date() })
    .where(eq(federatedActors.id, actorId));
}

/** Delete every actor row naming these protocol URIs. Returns the number removed. */
export async function deleteActorsByUris(
  uris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (uris.length === 0) return 0;
  const deleted = await db
    .delete(federatedActors)
    .where(inArray(federatedActors.uri, [...uris]))
    .returning({ id: federatedActors.id });
  return deleted.length;
}

/** The two columns the stale-actor refresh needs to re-fetch a profile. */
export interface StaleActorRef {
  uri: string;
  acct: string;
}

/**
 * Actors whose cached profile is stale AND that someone can still see: either
 * followed (in either direction) or resolved to an Oxy account, which means a
 * Mention user can land on the profile.
 *
 * `last_fetched_at IS NULL` is spelled out beside the `<` comparison because a
 * never-fetched actor is the MOST stale, and `NULL < threshold` is NULL — not
 * true — so the comparison alone excludes exactly the rows that need it most.
 */
export async function findStaleActorsForRefresh(
  staleThreshold: Date,
  followedUris: readonly string[],
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<StaleActorRef[]> {
  const reachable: SQL[] = [isNotNull(federatedActors.oxyUserId)];
  if (followedUris.length > 0) {
    reachable.unshift(inArray(federatedActors.uri, [...followedUris]));
  }

  return db
    .select({ uri: federatedActors.uri, acct: federatedActors.acct })
    .from(federatedActors)
    .where(
      and(
        or(
          sql`${federatedActors.lastFetchedAt} < ${staleThreshold}`,
          isNull(federatedActors.lastFetchedAt),
        ),
        or(...reachable),
      ),
    )
    .limit(limit);
}

/** The columns an outbox sync needs to fetch and attribute a remote actor's posts. */
export interface OutboxSyncActorRef {
  uri: string;
  acct: string;
  outboxUrl: string;
  oxyUserId?: string;
}

/** Followed actors that advertise an outbox, for the periodic catch-up sync. */
export async function findActorsWithOutboxByUris(
  uris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<OutboxSyncActorRef[]> {
  if (uris.length === 0) return [];
  const rows = await db
    .select({
      uri: federatedActors.uri,
      acct: federatedActors.acct,
      outboxUrl: federatedActors.outboxUrl,
      oxyUserId: federatedActors.oxyUserId,
    })
    .from(federatedActors)
    .where(and(inArray(federatedActors.uri, [...uris]), isNotNull(federatedActors.outboxUrl)));

  return rows.flatMap((row) =>
    row.outboxUrl === null
      ? []
      : [{
        uri: row.uri,
        acct: row.acct,
        outboxUrl: row.outboxUrl,
        oxyUserId: optional(row.oxyUserId),
      }],
  );
}

/** An actor the bounded historical backfill may advance, with its current progress. */
export interface OutboxBackfillCandidate extends OutboxSyncActorRef {
  id: string;
  outboxBackfill: FederatedOutboxBackfillState;
}

/**
 * Actors due a historical-backfill pass: resolved, advertising an outbox, not
 * finished, and not currently locked by another worker.
 *
 * Two total predicates carry the whole correctness of this query.
 *
 * `outbox_backfill_outbox_url IS DISTINCT FROM outbox_url` replaces
 * `{ $expr: { $ne: [...] } }`. It has to be `IS DISTINCT FROM` and not `<>`
 * because the left side is NULL for every actor that has never been backfilled —
 * the largest group this is meant to select — and `NULL <> 'https://…'` is NULL,
 * which `WHERE` discards. With `<>` the job would only ever pick up actors whose
 * remote had MOVED its outbox.
 *
 * `ORDER BY outbox_backfill_last_run_at ASC NULLS FIRST` replaces Mongo's
 * `sort({'outboxBackfill.lastRunAt': 1})`. Mongo puts a missing value first;
 * Postgres puts NULL last. Without `NULLS FIRST` an actor that has never been
 * backfilled sorts behind every actor that has, so on any instance with more
 * resolved actors than one batch, the ones that most need a first pass never get
 * one.
 */
export async function findOutboxBackfillCandidates(
  now: Date,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<OutboxBackfillCandidate[]> {
  const rows = await db
    .select()
    .from(federatedActors)
    .where(
      and(
        isNotNull(federatedActors.outboxUrl),
        isNotNull(federatedActors.oxyUserId),
        or(
          isNull(federatedActors.outboxBackfillStatus),
          inArray(federatedActors.outboxBackfillStatus, ['pending', 'failed']),
          sql`${federatedActors.outboxBackfillOutboxUrl} is distinct from ${federatedActors.outboxUrl}`,
        ),
        or(
          isNull(federatedActors.outboxBackfillLockedUntil),
          lte(federatedActors.outboxBackfillLockedUntil, now),
        ),
      ),
    )
    .orderBy(
      sql`${federatedActors.outboxBackfillLastRunAt} asc nulls first`,
      asc(federatedActors.updatedAt),
    )
    .limit(limit);

  return rows.flatMap((row) =>
    row.outboxUrl === null
      ? []
      : [{
        id: row.id,
        uri: row.uri,
        acct: row.acct,
        outboxUrl: row.outboxUrl,
        oxyUserId: optional(row.oxyUserId),
        outboxBackfill: assembleOutboxBackfill(row),
      }],
  );
}

/**
 * The backfill-progress columns a caller may write.
 *
 * Named after the RECORD's field names rather than the columns' so the call sites
 * keep reading like the state machine they implement; the mapping to the flat
 * `outbox_backfill_*` columns happens once, below.
 */
export interface OutboxBackfillPatch {
  status?: FederatedOutboxBackfillState['status'] | null;
  outboxUrl?: string | null;
  cursorUrl?: string | null;
  cursorItemOffset?: number;
  processedCount?: number;
  importedCount?: number;
  existingCount?: number;
  pageCount?: number;
  lockedUntil?: Date | null;
  lastRunAt?: Date | null;
  completedAt?: Date | null;
  lastError?: string | null;
}

/**
 * Translate a patch into the flat columns.
 *
 * The return type is the table's own `Partial<$inferInsert>`, so a property that
 * does not name a real column fails `tsc` here — the one place a stale dot path
 * could otherwise become a write that silently does nothing.
 */
function toBackfillColumns(patch: OutboxBackfillPatch): Partial<ActorInsert> {
  const columns: Partial<ActorInsert> = {};
  if (patch.status !== undefined) columns.outboxBackfillStatus = patch.status;
  if (patch.outboxUrl !== undefined) columns.outboxBackfillOutboxUrl = patch.outboxUrl;
  if (patch.cursorUrl !== undefined) columns.outboxBackfillCursorUrl = patch.cursorUrl;
  if (patch.cursorItemOffset !== undefined) {
    columns.outboxBackfillCursorItemOffset = patch.cursorItemOffset;
  }
  if (patch.processedCount !== undefined) columns.outboxBackfillProcessedCount = patch.processedCount;
  if (patch.importedCount !== undefined) columns.outboxBackfillImportedCount = patch.importedCount;
  if (patch.existingCount !== undefined) columns.outboxBackfillExistingCount = patch.existingCount;
  if (patch.pageCount !== undefined) columns.outboxBackfillPageCount = patch.pageCount;
  if (patch.lockedUntil !== undefined) columns.outboxBackfillLockedUntil = patch.lockedUntil;
  if (patch.lastRunAt !== undefined) columns.outboxBackfillLastRunAt = patch.lastRunAt;
  if (patch.completedAt !== undefined) columns.outboxBackfillCompletedAt = patch.completedAt;
  if (patch.lastError !== undefined) columns.outboxBackfillLastError = patch.lastError;
  return columns;
}

/** Write backfill progress unconditionally. */
export async function updateOutboxBackfill(
  actorId: string,
  patch: OutboxBackfillPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const columns = toBackfillColumns(patch);
  if (Object.keys(columns).length === 0) return;
  await db
    .update(federatedActors)
    .set({ ...columns, updatedAt: new Date() })
    .where(eq(federatedActors.id, actorId));
}

/**
 * Take the backfill lease on one actor, or report that someone else holds it.
 *
 * The lock predicate is re-tested INSIDE the update rather than trusted from the
 * candidate scan, so two workers that selected the same actor cannot both claim
 * it: the second one's `WHERE` no longer matches the row the first just locked.
 *
 * @returns whether this caller now holds the lease.
 */
export async function claimOutboxBackfill(
  actorId: string,
  now: Date,
  patch: OutboxBackfillPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const claimed = await db
    .update(federatedActors)
    .set({ ...toBackfillColumns(patch), updatedAt: new Date() })
    .where(
      and(
        eq(federatedActors.id, actorId),
        or(
          isNull(federatedActors.outboxBackfillLockedUntil),
          lte(federatedActors.outboxBackfillLockedUntil, now),
        ),
      ),
    )
    .returning({ id: federatedActors.id });
  return claimed.length > 0;
}
