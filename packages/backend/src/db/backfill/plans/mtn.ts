/**
 * The MTN protocol store: `mentionsignedrecords` `mentionrepoheads`
 * `mentionusernodes` `mentionnodeingestwitnesses`.
 *
 * ## Two of these collections have no model, and that is why they need reading
 *
 * `mentionsignedrecords` and `mentionrepoheads` had their Mongoose models
 * DELETED by this very port (`dd9b03e7`), so `Model.collection.collectionName`
 * cannot produce their names and no live schema states their field set. Both
 * were recovered from the parent of that commit rather than inferred from the
 * Postgres tables, which would have been circular — the tables are what the
 * migration is trying to fill correctly.
 *
 * ## Why the id preservation matters MORE here than anywhere else
 *
 * `schema/mtn.ts` states it and it is worth repeating where the transform is:
 * `rkey` is a Mongo `_id`, and `rkey`, `nsid` and `subject` are all INSIDE the
 * signed envelope. A remapped id therefore invalidates every record ever signed.
 * That is not a convenience argument for copying ids verbatim — it is the only
 * option that leaves the chain verifiable, and this file is where the claim is
 * cashed.
 *
 * The envelope itself is copied as jsonb VERBATIM. jsonb reorders keys,
 * collapses duplicates and reformats numbers, all of which are representation
 * changes that `canonicalize` normalizes away before the signature is checked —
 * so re-verification still passes. The one hazard is the correct failure mode: a
 * NUL byte anywhere in the envelope fails the INSERT loudly rather than
 * corrupting a signature quietly.
 *
 * ## `ingestedAt` is deliberately NOT a date
 *
 * `mention_node_ingest_witnesses.ingested_at` is a `bigint` of epoch
 * milliseconds, and the schema says why: the number is part of the canonicalized
 * signing input, so a `timestamptz` would re-render it and break the witness
 * signature. `int()` copies it as the number it is — passing it through `date()`
 * would be the exact mistake the column exists to prevent.
 */

import {
  mentionNodeIngestWitnesses,
  mentionRepoHeads,
  mentionSignedRecords,
  mentionUserNodes,
} from '../../schema/mtn';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import { bool, date, int, ownId, reqInt, reqJsonObject, reqStr, str } from '../values';
import { createdOnly, timestamps } from './timestamps';

/**
 * `mentionsignedrecords` → `mention_signed_records`.
 *
 * Append-only: the model declares `{ createdAt: true, updatedAt: false }` and
 * the table has no `updated_at`, which is the append-only contract stated at the
 * schema. Reading an `updatedAt` here would invent one.
 */
const mentionSignedRecordsPlan: CollectionPlan = {
  collection: 'mentionsignedrecords',
  table: mentionSignedRecords,
  enumAudits: [
    // NULLABLE, and the CHECK is `is null or in (…)` for exactly that reason:
    // v1 rows carry no `chainStatus` at all. The audit's null branch already
    // declines to report a null in a nullable column, so this reports only a
    // real third value.
    { path: 'chainStatus', column: mentionSignedRecords.chainStatus },
  ],
  numericAudits: [
    {
      path: 'seq',
      column: mentionSignedRecords.seq,
      constraint: 'mention_signed_records_seq_check',
      min: 0,
    },
  ],
  uniquenessAudits: [
    // All three are PARTIAL indexes (`where <column> is not null`), and NONE of
    // them declares a `where` here. That is deliberate and worth stating,
    // because a redundant predicate reads as load-bearing to the next person:
    //
    // `auditUniqueness` already restricts every group to rows where each key
    // part is present, because Postgres unique indexes are NULLS DISTINCT and a
    // row with a NULL in any indexed column never conflicts. For these three the
    // partial predicate IS "the key column is not null" — so the presence filter
    // reproduces it exactly, and a `where` would only restate it.
    //
    // A `where` becomes necessary when the index's predicate is about some OTHER
    // column (`where deleted_at is null`, `where status = 'open'`), which the
    // presence filter cannot express and which changes which rows collide.
    {
      index: 'mention_signed_records_record_id_key',
      key: [{ path: 'recordId', normalize: 'exact' }],
    },
    {
      index: 'mention_signed_records_oxy_user_id_seq_key',
      key: [
        { path: 'oxyUserId', normalize: 'exact' },
        { path: 'seq', normalize: 'exact' },
      ],
    },
    {
      index: 'mention_signed_records_idempotency_key',
      key: [
        { path: 'oxyUserId', normalize: 'exact' },
        { path: 'idempotencyKey', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      mentionSignedRecords,
      buildRow(
        mentionSignedRecords,
        {
          id: ownId(doc),
          subjectDid: reqStr(doc, 'subjectDid'),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          type: reqStr(doc, 'type'),
          // VERBATIM — see the module docblock for why jsonb is safe here and
          // what the one remaining hazard is.
          envelope: reqJsonObject(doc, 'envelope'),
          publicKey: reqStr(doc, 'publicKey'),
          verified: bool(doc, 'verified') ?? false,
          // Every one of these is v2-only and stays NULL on a v1 row. `prev` is
          // additionally NULL at genesis on a v2 chain, so a null here carries
          // two distinct meanings — both of which are correctly a NULL, and
          // neither of which may become `''`.
          seq: int(doc, 'seq'),
          prev: str(doc, 'prev'),
          recordId: str(doc, 'recordId'),
          chainStatus: str(doc, 'chainStatus'),
          idempotencyKey: str(doc, 'idempotencyKey'),
          nsid: str(doc, 'nsid'),
          rkey: str(doc, 'rkey'),
          ...createdOnly(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `mentionrepoheads` → `mention_repo_heads`. One row per user. */
const mentionRepoHeadsPlan: CollectionPlan = {
  collection: 'mentionrepoheads',
  table: mentionRepoHeads,
  numericAudits: [
    {
      path: 'seq',
      column: mentionRepoHeads.seq,
      constraint: 'mention_repo_heads_seq_check',
      min: 0,
    },
    {
      path: 'recordCount',
      column: mentionRepoHeads.recordCount,
      constraint: 'mention_repo_heads_record_count_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    {
      index: 'mention_repo_heads_oxy_user_id_key',
      key: [{ path: 'oxyUserId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    emit(
      mentionRepoHeads,
      buildRow(
        mentionRepoHeads,
        {
          id: ownId(doc),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          subjectDid: reqStr(doc, 'subjectDid'),
          seq: reqInt(doc, 'seq'),
          headRecordId: reqStr(doc, 'headRecordId'),
          recordCount: int(doc, 'recordCount') ?? 0,
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `mentionusernodes` → `mention_user_nodes`. One node per user. */
const mentionUserNodesPlan: CollectionPlan = {
  collection: 'mentionusernodes',
  table: mentionUserNodes,
  enumAudits: [
    { path: 'mode', column: mentionUserNodes.mode, absentAs: 'pull' },
    { path: 'controller', column: mentionUserNodes.controller, absentAs: 'self' },
    { path: 'status', column: mentionUserNodes.status, absentAs: 'active' },
  ],
  numericAudits: [
    {
      path: 'cursor',
      column: mentionUserNodes.cursor,
      constraint: 'mention_user_nodes_cursor_check',
      min: 0,
    },
  ],
  uniquenessAudits: [
    {
      index: 'mention_user_nodes_oxy_user_id_key',
      key: [{ path: 'oxyUserId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    const controller = str(doc, 'controller') ?? 'self';
    emit(
      mentionUserNodes,
      buildRow(
        mentionUserNodes,
        {
          id: ownId(doc),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          nodeDid: str(doc, 'nodeDid'),
          endpoint: reqStr(doc, 'endpoint'),
          nodePublicKey: reqStr(doc, 'nodePublicKey'),
          mode: str(doc, 'mode') ?? 'pull',
          // DERIVED from `controller`, not copied. `mention_user_nodes_managed_
          // controller_check` asserts `managed = (controller = 'oxy')`, and
          // Mongo held the two as INDEPENDENT fields with nothing keeping them
          // in step — so a document where they disagree is entirely possible and
          // copying both verbatim would fail the CHECK partway through the run.
          //
          // `controller` wins because it is the richer field: it says WHO
          // operates the node, while `managed` is a boolean restatement of the
          // same fact. Deriving cannot lose information in that direction, and
          // the reverse (`controller = managed ? 'oxy' : 'self'`) could.
          //
          // This is a transform DECISION rather than a documented resolution
          // rule because it changes no row's identity and removes nothing: the
          // constraint is a consistency rule the schema now enforces, and the
          // migration is satisfying it from the authoritative side. A rule would
          // be required if the answer were "drop the row" or "pick a survivor".
          managed: controller === 'oxy',
          controller,
          status: str(doc, 'status') ?? 'active',
          lastSeenAt: date(doc, 'lastSeenAt'),
          lastProbeAt: date(doc, 'lastProbeAt'),
          lastError: str(doc, 'lastError'),
          cursor: int(doc, 'cursor'),
          lastSyncedAt: date(doc, 'lastSyncedAt'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/**
 * `mentionnodeingestwitnesses` → `mention_node_ingest_witnesses`.
 *
 * Append-only and never updated, which is why the table has no `updated_at` —
 * the ABSENCE of that column is the contract.
 */
const mentionNodeIngestWitnessesPlan: CollectionPlan = {
  collection: 'mentionnodeingestwitnesses',
  table: mentionNodeIngestWitnesses,
  numericAudits: [
    {
      path: 'ingestedAt',
      column: mentionNodeIngestWitnesses.ingestedAt,
      constraint: 'mention_node_ingest_witnesses_ingested_at_check',
      min: 0,
    },
  ],
  uniquenessAudits: [
    {
      index: 'mention_node_ingest_witnesses_record_id_key',
      key: [{ path: 'recordId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    emit(
      mentionNodeIngestWitnesses,
      buildRow(
        mentionNodeIngestWitnesses,
        {
          id: ownId(doc),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          recordId: reqStr(doc, 'recordId'),
          witnessSignature: reqStr(doc, 'witnessSignature'),
          // A NUMBER, not a date — see the module docblock. `reqInt` is what
          // keeps it byte-identical inside the witness signing input.
          ingestedAt: reqInt(doc, 'ingestedAt'),
          ...createdOnly(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** Every MTN plan. */
export const MTN_PLANS: readonly CollectionPlan[] = [
  mentionSignedRecordsPlan,
  mentionRepoHeadsPlan,
  mentionUserNodesPlan,
  mentionNodeIngestWitnessesPlan,
];
