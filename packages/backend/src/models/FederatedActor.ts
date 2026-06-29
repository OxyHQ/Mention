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
  uri: string;
  username: string;
  domain: string;
  acct: string;
  summary?: string;
  avatarUrl?: string;
  headerUrl?: string;
  inboxUrl: string;
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

const FederatedActorSchema = new Schema<IFederatedActor>({
  uri: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true },
  domain: { type: String, required: true, index: true },
  acct: { type: String, required: true, unique: true, index: true },
  summary: { type: String },
  avatarUrl: { type: String },
  headerUrl: { type: String },
  inboxUrl: { type: String, required: true },
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
    name: { type: String },
    value: { type: String },
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
