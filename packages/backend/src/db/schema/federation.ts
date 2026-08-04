/**
 * The federation layer: `actor_key_pairs`, `federated_actors` (+ its profile
 * fields), `federated_follows`, `federated_media_cache`,
 * `federation_delivery_queue`.
 *
 * ## `actor_key_pairs.private_key_pem` is a PROTECTED column
 *
 * Mongoose marked nothing `select: false` anywhere in Mention, so
 * `ActorKeyPair.privateKeyPem` — the secret half of the key that signs every
 * outbound ActivityPub request for a user — was fully selectable and only stayed
 * out of responses because no DTO happened to include it. Drizzle's `select()`
 * returns every column, so the guard has to be added at the port rather than
 * inherited. See `protectedColumns.ts`.
 *
 * ## The schema does not normalize text, and that is deliberate
 *
 * `models/FederatedActor.ts` carries a long comment explaining that Mongoose's
 * `trim: true` was REMOVED from these fields because it was worse than nothing —
 * it strips the ends of a string and does nothing to the newline inside a display
 * name, which is the actual bug. Normalization belongs to the three ingest paths
 * that must strip HTML and decode entities BEFORE normalizing. Nothing is added
 * back here; a CHECK would reject production rows during the backfill and turn a
 * silent normalization into a 500.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';

/** The external networks an actor can belong to. */
export const FEDERATION_PROTOCOLS = ['activitypub', 'atproto'] as const;

/** ActivityPub actor types Mention accepts. */
export const FEDERATED_ACTOR_TYPES = [
  'Person',
  'Service',
  'Application',
  'Group',
  'Organization',
] as const;

/** `FederatedOutboxBackfillState.status`. */
export const OUTBOX_BACKFILL_STATUSES = ['pending', 'complete', 'unavailable', 'failed'] as const;

/** `FederatedFollow.direction`. */
export const FOLLOW_DIRECTIONS = ['outbound', 'inbound'] as const;

/** `FederatedFollow.status`. */
export const FOLLOW_STATUSES = ['pending', 'accepted', 'rejected'] as const;

/** `FEDERATED_MEDIA_CACHE_STATES`. */
export const FEDERATED_MEDIA_CACHE_STATES = ['pending', 'cached', 'evicted', 'failed'] as const;

/** `DeliveryStatus`. */
export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;

/**
 * `actor_key_pairs` — the RSA keypair Mention signs a local user's outbound
 * ActivityPub requests with. One per user.
 */
export const actorKeyPairs = pgTable(
  'actor_key_pairs',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One keypair per user. */
    oxyUserId: text().notNull().unique('actor_key_pairs_oxy_user_id_key'),
    publicKeyPem: text().notNull(),
    /** SECRET. Protected — see `protectedColumns.ts`. */
    privateKeyPem: text().notNull(),
    /** The advertised `keyId` URI (`https://<domain>/ap/users/<name>#main-key`). */
    keyId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }
);

/**
 * `federated_actors` — a remote account Mention knows about.
 *
 * `uri` is the actor's stable protocol id: the AP actor URI, or the DID for an
 * atproto actor. Both connectors key their upserts on it.
 */
export const federatedActors = pgTable(
  'federated_actors',
  {
    id: generatedId(),
    protocol: text({ enum: FEDERATION_PROTOCOLS }).notNull().default('activitypub'),
    uri: text().notNull().unique('federated_actors_uri_key'),
    username: text().notNull(),
    domain: text().notNull(),
    /** `<username>@<domain>`. Unique — the webfinger handle. */
    acct: text().notNull().unique('federated_actors_acct_key'),
    /**
     * The `<handle>@<network-domain>` identity a BRIDGED actor was re-labelled
     * onto (`wired@x.com`), NULL for every ordinary actor whose identity is its
     * acct.
     *
     * Deliberately separate from `domain`, which stays the host that delivered
     * the activity: the domain policy, the blocklist intelligence and the purge
     * scripts all key off that, and moving it onto `x.com` would make a real
     * moderation decision about the bridge invisible to them.
     *
     * It is also the ONLY field on which two rows for the same upstream person
     * match. The same X account mirrored by two different bridges has two URIs
     * and two accts and looks like two people everywhere else, so this is what
     * `resolveFederatedActorIdentity` de-duplicates on — hence indexed and
     * deliberately NOT unique: two rows sharing one `network_acct` is the normal
     * shape, and it is exactly what the de-duplication looks up.
     */
    networkAcct: text(),
    summary: text(),
    avatarUrl: text(),
    headerUrl: text(),
    /**
     * AP inbox. Required in practice for AP actors, optional on the schema
     * because atproto actors have none — they are read through the AppView and
     * never delivered to over ActivityPub.
     */
    inboxUrl: text(),
    outboxUrl: text(),
    sharedInboxUrl: text(),
    followersUrl: text(),
    followingUrl: text(),
    publicKeyPem: text(),
    publicKeyId: text(),
    type: text({ enum: FEDERATED_ACTOR_TYPES }).notNull().default('Person'),
    manuallyApprovesFollowers: boolean().notNull().default(false),
    discoverable: boolean().notNull().default(true),
    memorial: boolean().notNull().default(false),
    suspended: boolean().notNull().default(false),
    featuredUrl: text(),
    featuredTagsUrl: text(),
    /** `alsoKnownAs` — a scalar list of URIs, never joined. */
    alsoKnownAs: text().array(),
    remoteCreatedAt: timestamptz(),
    /**
     * Remote aggregate counts, stored as the remote reports them. UNVERIFIABLE
     * by construction — they are the remote instance's numbers about its own
     * account, not a count of anything in this database, which is exactly why
     * they are NOT copied onto `posts.stats_*`.
     */
    followersCount: integer().notNull().default(0),
    followingCount: integer().notNull().default(0),
    postsCount: integer().notNull().default(0),
    /** The Oxy account minted for this actor (Oxy type `'federated'`). */
    oxyUserId: text(),
    lastFetchedAt: timestamptz(),
    /**
     * The cooldown stamp behind the "silent sticky outage" in `AGENTS.md`: once
     * written, an empty first sync becomes permanent until it is cleared.
     */
    lastOutboxSyncAt: timestamptz(),

    // ── `outboxBackfill` subdocument ──
    outboxBackfillStatus: text({ enum: OUTBOX_BACKFILL_STATUSES }),
    outboxBackfillOutboxUrl: text(),
    outboxBackfillCursorUrl: text(),
    outboxBackfillCursorItemOffset: integer().notNull().default(0),
    outboxBackfillProcessedCount: integer().notNull().default(0),
    outboxBackfillImportedCount: integer().notNull().default(0),
    outboxBackfillExistingCount: integer().notNull().default(0),
    outboxBackfillPageCount: integer().notNull().default(0),
    outboxBackfillLockedUntil: timestamptz(),
    outboxBackfillLastRunAt: timestamptz(),
    outboxBackfillCompletedAt: timestamptz(),
    outboxBackfillLastError: text(),

    // ── atproto profile-graph sync ──
    //
    // Two stamps, not one, because they answer different questions and a single
    // column cannot do both: `lastAtprotoGraphSyncAt` is the COOLDOWN (when the
    // work last completed) and `atprotoGraphSyncStartedAt` is the LEASE (a run is
    // in flight, and since when). Collapsing them loses the ability to tell a
    // finished sync from a crashed one, which is what makes the lease reclaimable
    // after `ATPROTO_GRAPH_SYNC_LOCK_TTL_MS` instead of wedging the actor forever.
    //
    // Viewing any atproto profile can trigger this, and several public
    // profile-feed requests across several tasks arrive at once — so the claim is
    // a conditional UPDATE on these columns and the row count IS the answer. It
    // is deliberately NOT the `outbox_backfill_locked_until` lease beside it:
    // that one governs post import, this one governs starter-pack and custom-feed
    // resolution, and sharing a column would make either job silently starve the
    // other.
    lastAtprotoGraphSyncAt: timestamptz(),
    atprotoGraphSyncStartedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'federated_actors_protocol_check',
      sql`${t.protocol} in (${sql.raw(inList(FEDERATION_PROTOCOLS))})`
    ),
    check(
      'federated_actors_type_check',
      sql`${t.type} in (${sql.raw(inList(FEDERATED_ACTOR_TYPES))})`
    ),
    check(
      'federated_actors_outbox_backfill_status_check',
      sql`${t.outboxBackfillStatus} is null or ${t.outboxBackfillStatus} in (${sql.raw(inList(OUTBOX_BACKFILL_STATUSES))})`
    ),
    unique('federated_actors_domain_username_key').on(t.domain, t.username),
    index('federated_actors_protocol_idx').on(t.protocol),
    index('federated_actors_domain_idx').on(t.domain),
    // HTTP-signature verification resolves an actor by the key id in the header.
    index('federated_actors_public_key_id_idx')
      .on(t.publicKeyId)
      .where(sql`${t.publicKeyId} is not null`),
    // `refreshStaleActors()` scans oldest-fetched first.
    index('federated_actors_last_fetched_at_idx').on(t.lastFetchedAt),
    // The backfill worker's claim query.
    index('federated_actors_backfill_claim_idx').on(
      t.outboxBackfillStatus,
      t.outboxBackfillLockedUntil
    ),
    // Resolving an actor from the Oxy account it is linked to.
    index('federated_actors_oxy_user_id_idx')
      .on(t.oxyUserId)
      .where(sql`${t.oxyUserId} is not null`),
    // The duplicate-identity merge (`resolveFederatedActorIdentity`). Partial
    // because only bridged rows carry one — Mongo's index was `sparse` for the
    // same reason, and the overwhelming majority of rows are ordinary actors.
    index('federated_actors_network_acct_idx')
      .on(t.networkAcct)
      .where(sql`${t.networkAcct} is not null`),
  ]
);

/**
 * `federated_actor_fields` — the remote profile's `<name, value>` metadata rows
 * (Mastodon's verified links table).
 */
export const federatedActorFields = pgTable(
  'federated_actor_fields',
  {
    id: generatedId(),
    actorId: text()
      .notNull()
      .references(() => federatedActors.id, { onDelete: 'cascade' }),
    /** Preserves the order the remote profile lists them in. */
    position: integer().notNull(),
    name: text().notNull(),
    value: text().notNull(),
    /** Set when the remote instance verified the link (`rel=me`). */
    verifiedAt: timestamptz(),
  },
  (t) => [
    check('federated_actor_fields_position_check', sql`${t.position} >= 0`),
    unique('federated_actor_fields_actor_id_position_key').on(t.actorId, t.position),
  ]
);

/**
 * `federated_follows` — a follow edge across a protocol boundary.
 *
 * `remote_actor_uri` is a URI rather than a `federated_actors.id` because an
 * inbound Follow arrives for an actor Mention may not have fetched yet. That is
 * the honest shape and it is what the code queries on
 * (`FederatedFollow.distinct('remoteActorUri', …)`), so no foreign key.
 */
export const federatedFollows = pgTable(
  'federated_follows',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    localUserId: text().notNull(),
    /** The remote actor's URI/DID. Deliberately not a foreign key — see above. */
    remoteActorUri: text().notNull(),
    direction: text({ enum: FOLLOW_DIRECTIONS }).notNull(),
    status: text({ enum: FOLLOW_STATUSES }).notNull().default('pending'),
    network: text({ enum: FEDERATION_PROTOCOLS }).notNull().default('activitypub'),
    /**
     * The Follow activity URI we published, which embeds a `FederatedActor` id
     * (`<actor>/follows/<id>`). Remote servers hold this value, so it must
     * survive the migration byte for byte.
     */
    activityId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'federated_follows_direction_check',
      sql`${t.direction} in (${sql.raw(inList(FOLLOW_DIRECTIONS))})`
    ),
    check(
      'federated_follows_status_check',
      sql`${t.status} in (${sql.raw(inList(FOLLOW_STATUSES))})`
    ),
    check(
      'federated_follows_network_check',
      sql`${t.network} in (${sql.raw(inList(FEDERATION_PROTOCOLS))})`
    ),
    unique('federated_follows_local_remote_direction_key').on(
      t.localUserId,
      t.remoteActorUri,
      t.direction
    ),
    index('federated_follows_local_direction_status_idx').on(
      t.localUserId,
      t.direction,
      t.status
    ),
    index('federated_follows_remote_direction_idx').on(t.remoteActorUri, t.direction),
  ]
);

/**
 * `federated_media_cache` — the activity-based S3 cache for remote media.
 *
 * `remote_url` is the cache key and is never rewritten. An `evicted` row is KEPT
 * with its file ids cleared, so a later access re-enqueues rather than
 * re-discovering the URL from scratch.
 */
export const federatedMediaCache = pgTable(
  'federated_media_cache',
  {
    id: generatedId(),
    remoteUrl: text().notNull().unique('federated_media_cache_remote_url_key'),
    /** The Oxy S3 file id for the cached bytes. Set only while `cached`. */
    oxyFileId: text(),
    /** The Oxy S3 file id for an extracted video poster frame. */
    posterFileId: text(),
    contentType: text(),
    sizeBytes: integer(),
    state: text({ enum: FEDERATED_MEDIA_CACHE_STATES }).notNull().default('pending'),
    /** Drives the activity-based eviction job. */
    lastAccessedAt: timestamptz().notNull().defaultNow(),
    cachedAt: timestamptz(),
    /** Consecutive failed attempts, for backoff and for giving up. */
    failCount: integer().notNull().default(0),
    nextAttemptAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'federated_media_cache_state_check',
      sql`${t.state} in (${sql.raw(inList(FEDERATED_MEDIA_CACHE_STATES))})`
    ),
    check('federated_media_cache_fail_count_check', sql`${t.failCount} >= 0`),
    // The eviction job: cached entries idle past the TTL, oldest access first.
    index('federated_media_cache_state_accessed_idx').on(t.state, t.lastAccessedAt),
    // The worker claim: pending entries that are due.
    index('federated_media_cache_state_next_attempt_idx').on(t.state, t.nextAttemptAt),
  ]
);

/**
 * `federation_delivery_queue` — the LEGACY outbound delivery queue.
 *
 * Outbound delivery moved to BullMQ; this table exists to drain rows written
 * before that, and `migrated_to_bullmq` marks the ones already handed over so a
 * restart cannot enqueue the same delivery twice. It is a table with a planned
 * end, not a live queue — do not build anything new on it.
 *
 * `activity_json` is the one other legitimate `jsonb` in this schema: it is a
 * whole ActivityStreams document of arbitrary shape, defined by whatever
 * activity is being delivered.
 */
export const federationDeliveryQueue = pgTable(
  'federation_delivery_queue',
  {
    id: generatedId(),
    /** The full activity to POST. Genuinely shape-less, hence jsonb. */
    activityJson: jsonb().notNull(),
    targetInbox: text().notNull(),
    /** An Oxy account id — no foreign key. */
    senderOxyUserId: text().notNull(),
    attempts: integer().notNull().default(0),
    lastAttemptAt: timestamptz(),
    nextAttemptAt: timestamptz().notNull(),
    status: text({ enum: DELIVERY_STATUSES }).notNull().default('pending'),
    error: text(),
    migratedToBullmq: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'federation_delivery_queue_status_check',
      sql`${t.status} in (${sql.raw(inList(DELIVERY_STATUSES))})`
    ),
    check('federation_delivery_queue_attempts_check', sql`${t.attempts} >= 0`),
    index('federation_delivery_queue_drain_idx').on(t.status, t.nextAttemptAt),
  ]
);
