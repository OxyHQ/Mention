import mongoose, { Document, Schema } from 'mongoose';

/**
 * MentionRepoHead (MTN Protocol — per-subject hash chain, Workstream B / B1)
 *
 * The O(1) chain-head pointer for a subject's MTN signed-record chain. EXACTLY
 * ONE document per user. It lets the verifier check chain continuity in constant
 * time (`env.prev === head.headRecordId && env.seq === head.seq + 1`) without
 * scanning the append-only {@link IMentionSignedRecord} ledger, and lets the
 * write service fetch the current head before signing the next v2 record.
 *
 * Mirrors oxy-api's `RepoHead`, but keyed by `oxyUserId` (a string) — Mention's
 * chain key. The head is advanced transactionally together with the
 * `MentionSignedRecord` insert in the store's `append`; the unique
 * `{oxyUserId, seq}` index on `MentionSignedRecord` is the concurrency backstop
 * that serializes the multi-writer race.
 */
export interface IMentionRepoHead extends Document {
  /** The Oxy account id (string) that owns this chain (one head per user). */
  oxyUserId: string;
  /** The subject DID the chain is about (`did:web:<domain>:u:<oxyUserId>`). */
  subjectDid: string;
  /** The `seq` of the head (latest) record in the chain. */
  seq: number;
  /** The `recordId` (content address) of the head record. */
  headRecordId: string;
  /** Total number of chained records appended so far. */
  recordCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const MentionRepoHeadSchema = new Schema<IMentionRepoHead>(
  {
    oxyUserId: { type: String, required: true, unique: true },
    subjectDid: { type: String, required: true },
    seq: { type: Number, required: true },
    headRecordId: { type: String, required: true },
    recordCount: { type: Number, required: true, default: 0 },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    strict: true,
    minimize: false,
  },
);

export const MentionRepoHead = mongoose.model<IMentionRepoHead>('MentionRepoHead', MentionRepoHeadSchema);
export default MentionRepoHead;
