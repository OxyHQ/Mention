/**
 * The MTN protocol store: `mention_signed_records`, `mention_repo_heads`,
 * `mention_user_nodes`, `mention_node_ingest_witnesses`.
 *
 * ## `envelope` is jsonb, and it is safe — measured, not reasoned
 *
 * The signed envelope is stored VERBATIM and re-verified by recomputing the
 * canonical signing input from the PARSED value (`@oxyhq/protocol`'s
 * `canonicalize` sorts keys at every level). jsonb's key reordering, duplicate-
 * key collapse, number reformatting and unicode unescaping are therefore
 * representation-only: canonicalization normalizes all of them before the
 * signature is checked. One hazard remains and it is the correct failure mode —
 * a NUL byte anywhere in the envelope fails the INSERT loudly rather than
 * corrupting a signature silently.
 *
 * ## `rkey` IS a Mongo `_id`, and it is covered by the signature
 *
 * `MtnUri` is `mtn://<oxyUserId>/<collection>/<rkey>` and every emitter passes
 * `String(post._id)` / `String(like._id)` / `String(boost._id)` as the `rkey`;
 * `rkey`, `collection` and `subject` are all inside `SignedRecordSigningFields`.
 * A remapped id therefore invalidates every record ever signed. This is the
 * single strongest reason the migration preserves ids verbatim — it is not a
 * convenience, it is the only option that keeps the chain verifiable.
 *
 * ## The chain indexes are PARTIAL, exactly as in Mongo
 *
 * v1 rows carry none of `recordId`/`seq`/`nsid`/`idempotencyKey`. Mongo made
 * those indexes partial so a unique constraint would not collide across every
 * v1 row's missing field; Postgres treats NULLs as distinct in a plain unique
 * index, but the partial form is kept because it also keeps the index the size
 * of the v2 set and states the v1/v2 split at the constraint.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';

/** `MTN_CHAIN_STATUS` — local fork classification, outside the signed envelope. */
export const MTN_CHAIN_STATUSES = ['canonical', 'conflict'] as const;

/** `MentionUserNodeMode`. */
export const MENTION_NODE_MODES = ['pull', 'push'] as const;

/** `MentionUserNodeController` — who operates the node. */
export const MENTION_NODE_CONTROLLERS = ['self', 'oxy'] as const;

/** `MentionUserNodeStatus`. */
export const MENTION_NODE_STATUSES = ['active', 'unreachable', 'revoked'] as const;

/**
 * `mention_signed_records` — the append-only ledger of signed
 * `app.mention.feed.*` records.
 *
 * Never mutated or deleted; a newer record supersedes an older one by chain
 * order. The sole local-metadata exception is fork classification, which may set
 * `chain_status` and clear the denormalized `seq`/`prev` while leaving the signed
 * envelope byte-for-byte intact.
 */
export const mentionSignedRecords = pgTable(
  'mention_signed_records',
  {
    id: generatedId(),
    /** `did:web:<domain>:u:<oxyUserId>`. */
    subjectDid: text().notNull(),
    /** The Oxy account id owning the chain — Mention's chain key. No foreign key. */
    oxyUserId: text().notNull(),
    /** The open envelope `type` (Mention signs v2 records as `app_record`). */
    type: text().notNull(),
    /** The complete signed envelope, stored verbatim. See the module docblock. */
    envelope: jsonb().notNull(),
    /** The secp256k1 public key that signed it (a current VM at write time). */
    publicKey: text().notNull(),
    verified: boolean().notNull().default(false),
    /**
     * v2 only: strictly-increasing sequence for this subject's chain.
     * `bigint` with `mode: 'number'` — a chain counter is unbounded in principle
     * and `integer` would cap it at 2^31, which is a limit nobody chose.
     */
    seq: bigint({ mode: 'number' }),
    /** v2 only: the previous record's `recordId`; NULL at genesis. */
    prev: text(),
    /** v2 only: the content address (sha256 of the canonical signing input). */
    recordId: text(),
    chainStatus: text({ enum: MTN_CHAIN_STATUSES }),
    /**
     * Durable producer-event identity. NOT part of the signed envelope and NOT
     * the logical rkey — it exists only to make at-least-once local delivery
     * idempotent, so a like → tombstone → re-like cycle keeps its normal rkey
     * while each outbox revision gets its own identity.
     */
    idempotencyKey: text(),
    /**
     * v2 only: the AtProto-style collection NSID (`app.mention.feed.post`).
     *
     * The column is `nsid`, not `collection`, because Mongoose reserves
     * `Document.collection`. Postgres has no such reservation, but the name is
     * kept: it is what every query, the oxy-api sibling model and the code
     * comments already say, and renaming it would be a gratuitous divergence.
     */
    nsid: text(),
    /** v2 only: the record key within the collection — a Mongo `_id`. */
    rkey: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'mention_signed_records_chain_status_check',
      sql`${t.chainStatus} is null or ${t.chainStatus} in (${sql.raw(inList(MTN_CHAIN_STATUSES))})`
    ),
    check('mention_signed_records_seq_check', sql`${t.seq} is null or ${t.seq} >= 0`),
    // Globally-unique content address (Mongo `recordId_1`, partial on string).
    uniqueIndex('mention_signed_records_record_id_key')
      .on(t.recordId)
      .where(sql`${t.recordId} is not null`),
    // The concurrency backstop for the multi-writer append race: the loser of
    // two concurrent writes at the same seq gets a duplicate-key error and
    // re-reads the head. Also serves ordered `getLogSince` pagination.
    uniqueIndex('mention_signed_records_oxy_user_id_seq_key')
      .on(t.oxyUserId, t.seq)
      .where(sql`${t.seq} is not null`),
    // At-least-once delivery idempotency (Mongo `mtn_event_idempotency_unique_v1`).
    uniqueIndex('mention_signed_records_idempotency_key')
      .on(t.oxyUserId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // v2 materialization: the latest record for an (nsid, rkey) key.
    index('mention_signed_records_materialize_idx')
      .on(t.oxyUserId, t.nsid, t.rkey, t.createdAt.desc())
      .where(sql`${t.nsid} is not null`),
    index('mention_signed_records_subject_did_idx').on(t.subjectDid),
  ]
);

/**
 * `mention_repo_heads` — the O(1) chain-head pointer. Exactly one per user.
 *
 * Lets the verifier check continuity in constant time
 * (`env.prev === head.headRecordId && env.seq === head.seq + 1`) without
 * scanning the append-only ledger. Advanced transactionally with the record
 * insert; the unique `(oxy_user_id, seq)` index above is the backstop.
 */
export const mentionRepoHeads = pgTable(
  'mention_repo_heads',
  {
    id: generatedId(),
    /** One head per user. No foreign key (Oxy owns accounts). */
    oxyUserId: text().notNull().unique('mention_repo_heads_oxy_user_id_key'),
    subjectDid: text().notNull(),
    seq: bigint({ mode: 'number' }).notNull(),
    headRecordId: text().notNull(),
    recordCount: bigint({ mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('mention_repo_heads_seq_check', sql`${t.seq} >= 0`),
    check('mention_repo_heads_record_count_check', sql`${t.recordCount} >= 0`),
  ]
);

/**
 * `mention_user_nodes` — the operational cache of a user's registered personal
 * data node.
 *
 * The AUTHORITY is a signed `app.mention.node` record on the user's chain; this
 * row is a denormalized projection plus the liveness state the background worker
 * maintains. Nothing in a request's READ path touches it, so a node being down
 * makes this row stale-but-instant, never slow.
 */
export const mentionUserNodes = pgTable(
  'mention_user_nodes',
  {
    id: generatedId(),
    /** One node per user. No foreign key. */
    oxyUserId: text().notNull().unique('mention_user_nodes_oxy_user_id_key'),
    /** A DID the node advertises for itself. Informational. */
    nodeDid: text(),
    /** The node's public HTTPS base URL. */
    endpoint: text().notNull(),
    /** The node's secp256k1 public key (hex). */
    nodePublicKey: text().notNull(),
    mode: text({ enum: MENTION_NODE_MODES }).notNull().default('pull'),
    /** True when Mention operates the node on the user's behalf. */
    managed: boolean().notNull().default(false),
    controller: text({ enum: MENTION_NODE_CONTROLLERS }).notNull().default('self'),
    status: text({ enum: MENTION_NODE_STATUSES }).notNull().default('active'),
    lastSeenAt: timestamptz(),
    lastProbeAt: timestamptz(),
    lastError: text(),
    /** How far Mention has mirrored the node's chain back in. */
    cursor: bigint({ mode: 'number' }),
    lastSyncedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('mention_user_nodes_mode_check', sql`${t.mode} in (${sql.raw(inList(MENTION_NODE_MODES))})`),
    check(
      'mention_user_nodes_controller_check',
      sql`${t.controller} in (${sql.raw(inList(MENTION_NODE_CONTROLLERS))})`
    ),
    check(
      'mention_user_nodes_status_check',
      sql`${t.status} in (${sql.raw(inList(MENTION_NODE_STATUSES))})`
    ),
    check('mention_user_nodes_cursor_check', sql`${t.cursor} is null or ${t.cursor} >= 0`),
    // A managed node is operated by Oxy, by definition — the two flags cannot
    // disagree. Mongo held them as two independent fields.
    check(
      'mention_user_nodes_managed_controller_check',
      sql`${t.managed} = (${t.controller} = 'oxy')`
    ),
    index('mention_user_nodes_status_idx').on(t.status),
    // The ingest sweep picks the least-recently-synced `pull` nodes first.
    index('mention_user_nodes_ingest_sweep_idx').on(t.status, t.mode, t.lastSyncedAt),
  ]
);

/**
 * `mention_node_ingest_witnesses` — an append-only, Mention-counter-signed
 * attestation over each record ingested from a user's node.
 *
 * The node holds the user's own signing key; if that key were stolen, an
 * attacker could re-sign a DIFFERENT history and present it as authentic. This
 * binds the first `recordId` Mention ever saw at a content address to a
 * timestamp under Mention's independent key, so a later silent rewrite cannot
 * claim the old content never existed.
 *
 * One witness per `record_id` — witnessing is idempotent, so a record re-pulled
 * on a later sweep is never double-witnessed. Never mutated or deleted, which is
 * why there is no `updated_at`: the ABSENCE of that column is the append-only
 * contract.
 */
export const mentionNodeIngestWitnesses = pgTable(
  'mention_node_ingest_witnesses',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /** The content address Mention witnessed. Globally unique. */
    recordId: text().notNull().unique('mention_node_ingest_witnesses_record_id_key'),
    /** DER secp256k1 signature by the Mention custodial key. */
    witnessSignature: text().notNull(),
    /**
     * When Mention first ingested and witnessed this record.
     *
     * Mongo stored a raw millisecond NUMBER because it is part of the
     * canonicalized signing input (`{ recordId, oxyUserId, ingestedAt }`) and
     * must round-trip byte-identically. A `timestamptz` would re-render it, so
     * the number is preserved exactly — this is the one place a date is
     * deliberately NOT a `timestamptz`.
     */
    ingestedAt: bigint({ mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('mention_node_ingest_witnesses_ingested_at_check', sql`${t.ingestedAt} >= 0`),
    // Per-user audit reads, newest first.
    index('mention_node_ingest_witnesses_owner_chrono_idx').on(t.oxyUserId, t.createdAt.desc()),
  ]
);
