import mongoose, { Document, Schema } from 'mongoose';

export interface IFederatedActor extends Document {
  uri: string;
  username: string;
  domain: string;
  acct: string;
  displayName?: string;
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
  followersCount: number;
  followingCount: number;
  postsCount: number;
  lastFetchedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const FederatedActorSchema = new Schema<IFederatedActor>({
  uri: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true },
  domain: { type: String, required: true, index: true },
  acct: { type: String, required: true, unique: true, index: true },
  displayName: { type: String },
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
  followersCount: { type: Number, default: 0 },
  followingCount: { type: Number, default: 0 },
  postsCount: { type: Number, default: 0 },
  lastFetchedAt: { type: Date },
}, {
  timestamps: true,
});

FederatedActorSchema.index({ domain: 1, username: 1 }, { unique: true });

export const FederatedActor = mongoose.model<IFederatedActor>('FederatedActor', FederatedActorSchema);
export default FederatedActor;
