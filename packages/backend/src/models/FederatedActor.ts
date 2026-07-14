import mongoose, { Document, Schema } from 'mongoose';

export interface FederatedActorField {
  name: string;
  value: string;
  verifiedAt?: Date;
}

export interface FederatedOutboxBackfillState {
  status?: 'pending' | 'complete' | 'unavailable' | 'failed';
  outboxUrl?: string;
  cursorUrl?: string;
  cursorItemOffset?: number;
  processedCount?: number;
  importedCount?: number;
  existingCount?: number;
  pageCount?: number;
  lockedUntil?: Date;
  lastRunAt?: Date;
  completedAt?: Date;
  lastError?: string;
}

export interface IFederatedActor extends Document {
  /**
   * The external network this actor belongs to. ActivityPub (Mastodon/fediverse)
   * actors default here; atproto (Bluesky) actors carry `'atproto'`. Lets every
   * protocol-agnostic query (`/federation/*` follow/post routes, the profile-sync
   * dispatcher) route an actor to the connector that owns it.
   */
  protocol: 'activitypub' | 'atproto';
  /**
   * The actor's stable protocol id and unique key. For ActivityPub this is the
   * actor URI; for atproto it is the actor's DID (`did:plc:...` / `did:web:...`).
   * Both connectors key their upserts on `uri`, and protocol-agnostic queries
   * (the `connectorFor` dispatch, follow records) resolve actors through it.
   */
  uri: string;
  username: string;
  domain: string;
  acct: string;
  summary?: string;
  avatarUrl?: string;
  headerUrl?: string;
  /**
   * ActivityPub inbox URL. REQUIRED in practice for AP actors (every AP ingest
   * path sets it), but optional on the schema because atproto actors have no AP
   * inbox — they are read/discovered through the AppView, never delivered to over
   * ActivityPub. AP delivery code reads `sharedInboxUrl ?? inboxUrl` and guards
   * the absent case.
   */
  inboxUrl?: string;
  outboxUrl?: string;
  sharedInboxUrl?: string;
  followersUrl?: string;
  followingUrl?: string;
  publicKeyPem?: string;
  publicKeyId?: string;
  type: string;
  manuallyApprovesFollowers: boolean;
  discoverable: boolean;
  memorial: boolean;
  suspended: boolean;
  fields: FederatedActorField[];
  featuredUrl?: string;
  featuredTagsUrl?: string;
  alsoKnownAs?: string[];
  remoteCreatedAt?: Date;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  oxyUserId?: string;
  lastFetchedAt?: Date;
  lastOutboxSyncAt?: Date;
  outboxBackfill?: FederatedOutboxBackfillState;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Every text field on this model is REMOTE text, so each one carries `trim`.
 * That is defense in depth ONLY: Mongoose's `trim` strips the ends of the string
 * and does nothing to the whitespace INSIDE it, which is where the damage is (a
 * newline in a display name, a blank line in a bio). The real normalization
 * happens at ingest — `actor.service.ts` and `profile.mapper.ts` run every one
 * of these values through the canonical `normalizeInlineText` /
 * `normalizeMultilineText` from `@oxyhq/core` before they ever reach the model.
 */
const FederatedActorSchema = new Schema<IFederatedActor>({
  protocol: { type: String, enum: ['activitypub', 'atproto'], default: 'activitypub', index: true },
  uri: { type: String, required: true, unique: true, index: true, trim: true },
  username: { type: String, required: true, trim: true },
  domain: { type: String, required: true, index: true, trim: true },
  acct: { type: String, required: true, unique: true, index: true, trim: true },
  summary: { type: String, trim: true },
  avatarUrl: { type: String },
  headerUrl: { type: String },
  inboxUrl: { type: String },
  outboxUrl: { type: String },
  sharedInboxUrl: { type: String },
  followersUrl: { type: String },
  followingUrl: { type: String },
  publicKeyPem: { type: String },
  publicKeyId: { type: String },
  type: { type: String, default: 'Person', enum: ['Person', 'Service', 'Application', 'Group', 'Organization'] },
  manuallyApprovesFollowers: { type: Boolean, default: false },
  discoverable: { type: Boolean, default: true },
  memorial: { type: Boolean, default: false },
  suspended: { type: Boolean, default: false },
  fields: [{
    name: { type: String, trim: true },
    value: { type: String, trim: true },
    verifiedAt: { type: Date },
  }],
  featuredUrl: { type: String },
  featuredTagsUrl: { type: String },
  alsoKnownAs: [{ type: String }],
  remoteCreatedAt: { type: Date },
  followersCount: { type: Number, default: 0 },
  followingCount: { type: Number, default: 0 },
  postsCount: { type: Number, default: 0 },
  oxyUserId: { type: String, index: { sparse: true } },
  lastFetchedAt: { type: Date },
  lastOutboxSyncAt: { type: Date },
  outboxBackfill: {
    status: { type: String, enum: ['pending', 'complete', 'unavailable', 'failed'] },
    outboxUrl: { type: String },
    cursorUrl: { type: String },
    cursorItemOffset: { type: Number, default: 0 },
    processedCount: { type: Number, default: 0 },
    importedCount: { type: Number, default: 0 },
    existingCount: { type: Number, default: 0 },
    pageCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastRunAt: { type: Date },
    completedAt: { type: Date },
    lastError: { type: String },
  },
}, {
  timestamps: true,
});

FederatedActorSchema.index({ domain: 1, username: 1 }, { unique: true });
FederatedActorSchema.index({ lastFetchedAt: 1 }); // For refreshStaleActors() job queries
FederatedActorSchema.index({ publicKeyId: 1 }, { sparse: true }); // For HTTP signature verification lookups
FederatedActorSchema.index({ 'outboxBackfill.status': 1, 'outboxBackfill.lockedUntil': 1 });

export const FederatedActor = mongoose.model<IFederatedActor>('FederatedActor', FederatedActorSchema);
export default FederatedActor;
