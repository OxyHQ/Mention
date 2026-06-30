import mongoose, { Document, Schema } from 'mongoose';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

/**
 * MentionSignedRecord (MTN Protocol — per-subject hash chain, Workstream B / B1)
 *
 * Append-only ledger of cryptographically-signed `app.mention.feed.*` records a
 * user publishes in Mention (posts / likes / reposts / tombstones / bookmarks).
 * Each row stores the FULL signed envelope verbatim plus denormalised fields for
 * indexing. Rows are never mutated or deleted — a newer record (a tombstone, an
 * edit version) simply supersedes an older one by chain order.
 *
 * This MIRRORS oxy-api's `SignedRecord` model, but it lives in MENTION's Mongo
 * and is keyed by `oxyUserId` (the user's Oxy account id as a STRING) instead of
 * an Oxy `userId` ObjectId — Mention has no `User` collection. Identity/signing
 * is Oxy's (the subject DID is `buildUserDid(oxyUserId)` and the signing key is a
 * verification method of that DID, or the Mention custodial key); the storage is
 * 100% Mention's.
 *
 * ## v2 hash chain
 *
 * v2 envelopes carry a per-subject hash chain ("personal blockchain" of a single
 * signer, no consensus/mining): `seq` (strictly-increasing per subject), `prev`
 * (the `recordId` of the previous record, `null` at genesis), and an AtProto-style
 * record key — `collection` + `rkey` on the wire — for materialization + LWW.
 * `recordId` is the SHA-256 of the canonical signing input (`@oxyhq/protocol`'s
 * `computeRecordId`) — the content address that the NEXT record's `prev`
 * references. The DENORMALIZED column for the wire `collection` field is named
 * `nsid` (the reserved Mongoose `Document.collection` member forces the rename),
 * exactly as in oxy-api.
 *
 * v1 rows carry NONE of the chain fields; the chain indexes are PARTIAL (they
 * only cover rows where the field exists), so a unique `recordId`/`{oxyUserId,seq}`
 * index never collides over the absent v1 fields. Mention emits only v2 records,
 * but the v1-tolerant shape is kept so the model is a faithful port.
 */
export interface IMentionSignedRecord extends Document {
  /** The subject DID the record is about (`did:web:<domain>:u:<oxyUserId>`). */
  subjectDid: string;
  /** The Oxy account id (string) that owns the subject DID — Mention's chain key. */
  oxyUserId: string;
  /** The open envelope `type` (Mention signs v2 records as `app_record`). */
  type: string;
  /** The complete signed envelope as published. */
  envelope: SignedRecordEnvelope;
  /** The secp256k1 public key that signed the envelope (a current VM at write time). */
  publicKey: string;
  verified: boolean;
  /** v2 only: strictly-increasing sequence number for this subject's chain. */
  seq?: number;
  /** v2 only: `recordId` of the previous record in the chain, `null` at genesis. */
  prev?: string | null;
  /** v2 only: content address (sha256 of the canonical signing input). UNIQUE. */
  recordId?: string;
  /**
   * v2 only: AtProto-style collection namespace / NSID (e.g. `app.mention.feed.post`).
   * Denormalized from the envelope's `collection` field (renamed here to avoid
   * the reserved Mongoose `Document.collection` member).
   */
  nsid?: string;
  /** v2 only: AtProto-style record key within the collection (e.g. a post id). */
  rkey?: string;
  createdAt: Date;
}

const MentionSignedRecordSchema = new Schema<IMentionSignedRecord>(
  {
    subjectDid: { type: String, required: true, index: true },
    oxyUserId: { type: String, required: true },
    // The open envelope `type` is stored verbatim (no enum) — Mention re-narrows
    // it to `app_record` in the write service, not at the schema layer.
    type: { type: String, required: true },
    // The envelope is contract-validated before it ever reaches the model, so it
    // is stored verbatim as a Mixed subdocument.
    envelope: { type: Schema.Types.Mixed, required: true },
    publicKey: { type: String, required: true },
    verified: { type: Boolean, default: false },
    // v2 hash-chain fields (absent on v1 rows). `nsid` is the denormalized
    // envelope `collection` (renamed to avoid the reserved Mongoose member).
    seq: { type: Number },
    prev: { type: String, default: undefined },
    recordId: { type: String },
    nsid: { type: String },
    rkey: { type: String },
  },
  {
    // Append-only: stamp createdAt, never updatedAt.
    timestamps: { createdAt: true, updatedAt: false },
    strict: true,
    minimize: false,
  },
);

// v2 chain: globally-unique content address. Partial so the absent v1 `recordId`
// never collides (Mongo treats a missing field as null, which would otherwise
// dupe across every v1 row).
MentionSignedRecordSchema.index(
  { recordId: 1 },
  { unique: true, partialFilterExpression: { recordId: { $type: 'string' } } },
);

// v2 chain: one record per (oxyUserId, seq) — the concurrency backstop for the
// multi-writer race (the loser of two concurrent writes at the same seq gets a
// duplicate-key error and re-reads the head). Partial so v1 rows (no `seq`) are
// excluded. Also serves ordered `getLogSince` pagination.
MentionSignedRecordSchema.index(
  { oxyUserId: 1, seq: 1 },
  { unique: true, partialFilterExpression: { seq: { $type: 'number' } } },
);

// v2 materialization: latest verified record for an AtProto-style (nsid, rkey)
// key. Partial so v1 rows are excluded from this index.
MentionSignedRecordSchema.index(
  { oxyUserId: 1, nsid: 1, rkey: 1, createdAt: -1 },
  { partialFilterExpression: { nsid: { $type: 'string' } } },
);

export const MentionSignedRecord = mongoose.model<IMentionSignedRecord>(
  'MentionSignedRecord',
  MentionSignedRecordSchema,
);
export default MentionSignedRecord;
