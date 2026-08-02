/**
 * `FederatedActorRecord` — the shape a remote actor has once it leaves the
 * database.
 *
 * The storage is two tables (`federated_actors` plus the ordered
 * `federated_actor_fields`) and a dozen flat `outbox_backfill_*` columns. This is
 * the shape every consumer reads instead, and `actorRepository.ts` is the only
 * module allowed to know the difference.
 *
 * ## `outboxBackfill` is always present, and that is a simplification, not a change
 *
 * Mongo stored it as an optional subdocument, so every reader already spells the
 * access `actor.outboxBackfill?.status`. The Postgres columns backing the
 * counters are `NOT NULL DEFAULT 0`, so a "missing" subdocument and a
 * never-written one are indistinguishable by any predicate a caller writes: both
 * answer `undefined` for `status`/`outboxUrl`/`cursorUrl` and `0` for every
 * counter. Assembling it unconditionally removes an optional level nothing could
 * observe. Every field that was genuinely absent stays `undefined`.
 *
 * ## `fields` is NOT on this record
 *
 * The verified-links table is written by the actor upsert and read by exactly one
 * consumer — `scripts/normalizeFederatedText.ts`. Joining it into every actor read
 * would put a second query on the hottest path in federation (actor resolution
 * runs on every inbound activity) to serve one maintenance script, so it is
 * loaded on demand by `loadActorFields` instead.
 */

import type {
  FEDERATED_ACTOR_TYPES,
  FEDERATION_PROTOCOLS,
  OUTBOX_BACKFILL_STATUSES,
} from '../schema/federation';

/** `activitypub` | `atproto`. */
export type FederationProtocol = (typeof FEDERATION_PROTOCOLS)[number];

/** The ActivityPub actor types Mention accepts. */
export type FederatedActorType = (typeof FEDERATED_ACTOR_TYPES)[number];

/** `pending` | `complete` | `unavailable` | `failed`. */
export type OutboxBackfillStatus = (typeof OUTBOX_BACKFILL_STATUSES)[number];

/** One `<name, value>` row of a remote profile's verified-links table. */
export interface FederatedActorField {
  name: string;
  value: string;
  verifiedAt?: Date;
}

/**
 * The cursor + counters of the bounded historical outbox backfill.
 *
 * The counters are non-optional because their columns are `NOT NULL DEFAULT 0`;
 * everything genuinely absent until the first run stays optional.
 */
export interface FederatedOutboxBackfillState {
  status?: OutboxBackfillStatus;
  /**
   * The outbox URL this progress was measured against. A mismatch with the
   * actor's CURRENT `outboxUrl` means the remote moved its outbox and the
   * counters describe a collection that no longer exists — every reader
   * compares the two rather than trusting `status` alone.
   */
  outboxUrl?: string;
  cursorUrl?: string;
  cursorItemOffset: number;
  processedCount: number;
  importedCount: number;
  existingCount: number;
  pageCount: number;
  lockedUntil?: Date;
  lastRunAt?: Date;
  completedAt?: Date;
  lastError?: string;
}

/** A remote account Mention knows about. */
export interface FederatedActorRecord {
  id: string;
  protocol: FederationProtocol;
  /** The actor's stable protocol id: an AP actor URI, or an atproto DID. */
  uri: string;
  username: string;
  domain: string;
  /** `<username>@<domain>` — the webfinger handle. */
  acct: string;
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
  type: FederatedActorType;
  manuallyApprovesFollowers: boolean;
  discoverable: boolean;
  memorial: boolean;
  suspended: boolean;
  featuredUrl?: string;
  featuredTagsUrl?: string;
  alsoKnownAs?: string[];
  remoteCreatedAt?: Date;
  /** Remote aggregate counts, as the remote reports them. Unverifiable. */
  followersCount: number;
  followingCount: number;
  postsCount: number;
  /** The Oxy account minted for this actor (Oxy type `'federated'`). */
  oxyUserId?: string;
  lastFetchedAt?: Date;
  lastOutboxSyncAt?: Date;
  outboxBackfill: FederatedOutboxBackfillState;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The record as `@oxyhq/federation` requires it: `id`, plus the SAME value under
 * the `_id` its published `FederatedActorRecordBase` / `DeliveryActorFields`
 * contracts name.
 *
 * This is not cosmetic, and dropping it fails in two ways that look nothing alike.
 *
 * 1. **It is inside activity ids remote servers already hold.** The engine builds
 *    the outbound Follow id as `` `${localActorUri}/follows/${cached._id}` `` and
 *    the matching Undo as `` `${localActorUri}/follows/${actor._id}/undo` ``.
 *    That is the value stored in `federated_follows.activity_id`, which the
 *    schema documents as having to survive the migration byte for byte — a
 *    remote instance correlates an Undo with the Follow it retracts by this
 *    string. Since the backfill copies `_id` verbatim into `federated_actors.id`,
 *    aliasing the two keeps every already-published id resolvable; omitting it
 *    would fall through to the engine's `encodeURIComponent(uri)` branch and mint
 *    a different id for every existing actor.
 * 2. **It gates the Oxy-user stamp, silently.** The resolver writes
 *    `if (oxyId && fedActor.oxyUserId !== oxyId && fedActor._id != null)` before
 *    calling `store.setActorOxyUserId`, so a record without `_id` never gets its
 *    resolved Oxy account written. Every inbound Create from that actor would
 *    then raise `ActorResolutionPendingError` and nothing would log an error.
 *
 * The alias therefore lives at exactly two boundaries — the store adapters in
 * `connectors/activitypub/actor.service.ts` and
 * `connectors/activitypub/delivery.service.ts` — and nowhere else in Mention. The
 * clean fix is a store-agnostic id on the engine's own store interfaces, which is
 * an `@oxyhq/federation` change and a breaking one for the Oxy apps still on
 * Mongo.
 */
export type EngineFederatedActorRecord = FederatedActorRecord & { _id: string };

/**
 * Republish a record's primary key under the `_id` the engine's contracts name.
 *
 * The ONLY producer of {@link EngineFederatedActorRecord} — everywhere Mention
 * hands a record to `@oxyhq/federation` goes through here, so the alias is
 * grep-able to a single function rather than spread across three adapters.
 */
export function withEngineId(record: FederatedActorRecord): EngineFederatedActorRecord;
export function withEngineId(record: FederatedActorRecord | null): EngineFederatedActorRecord | null;
export function withEngineId(
  record: FederatedActorRecord | null,
): EngineFederatedActorRecord | null {
  return record === null ? null : { ...record, _id: record.id };
}
