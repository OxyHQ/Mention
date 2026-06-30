import mongoose, { Document, Schema } from 'mongoose';

/**
 * MentionNodeIngestWitness (MTN Protocol — B3 node→Mention ingest)
 *
 * An append-only, Mention-COUNTER-SIGNED witness over each signed record Mention
 * ingests from a user's personal data node. When the background ingest worker
 * mirrors a record (content address `recordId`) from a node into Mention's
 * `MentionSignedRecord` store, it ALSO produces a small `ES256K-DER-SHA256`
 * signature over `canonicalize({ recordId, oxyUserId, ingestedAt })` using the
 * Mention custodial key (`MENTION_PRIVATE_KEY`, the verification method of
 * `MENTION_DID`).
 *
 * This MIRRORS oxy-api's `NodeIngestWitness` model, but it lives in MENTION's
 * Mongo and is keyed by `oxyUserId` (the user's Oxy account id as a STRING)
 * instead of an Oxy `userId` ObjectId — Mention has no `User` collection.
 *
 * ## Why a counter-sign
 *
 * The node holds the user's own signing key. If that key were ever stolen, an
 * attacker could re-sign a DIFFERENT history and present it as authentic. This
 * witness binds the FIRST recordId Mention ever saw at a given content address to
 * a timestamp under Mention's independent key — an immutable, third-party
 * attestation of "Mention observed this exact record at this time". A later
 * silent rewrite can no longer claim the old content never existed.
 *
 * One witness per `recordId` (unique) — witnessing is idempotent, so a record
 * re-pulled on a later sweep is never double-witnessed. The store is never
 * mutated or deleted.
 */
export interface IMentionNodeIngestWitness extends Document {
  /** The Oxy account id (string) whose chain the witnessed record belongs to. */
  oxyUserId: string;
  /** The content address (sha256 of the canonical signing input) Mention witnessed. */
  recordId: string;
  /** DER-encoded secp256k1 signature by the Mention custodial key over the witness input. */
  witnessSignature: string;
  /** When Mention first ingested + witnessed this recordId (ms epoch). */
  ingestedAt: number;
  createdAt: Date;
}

const MentionNodeIngestWitnessSchema = new Schema<IMentionNodeIngestWitness>(
  {
    oxyUserId: { type: String, required: true },
    recordId: { type: String, required: true, unique: true },
    witnessSignature: { type: String, required: true },
    ingestedAt: { type: Number, required: true },
  },
  {
    // Append-only: stamp createdAt, never updatedAt.
    timestamps: { createdAt: true, updatedAt: false },
    strict: true,
    minimize: false,
  },
);

// Per-user audit reads (newest first).
MentionNodeIngestWitnessSchema.index({ oxyUserId: 1, createdAt: -1 });

export const MentionNodeIngestWitness = mongoose.model<IMentionNodeIngestWitness>(
  'MentionNodeIngestWitness',
  MentionNodeIngestWitnessSchema,
);
export default MentionNodeIngestWitness;
