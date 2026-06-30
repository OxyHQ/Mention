import mongoose, { Document, Schema } from 'mongoose';

export type FollowDirection = 'outbound' | 'inbound';
export type FollowStatus = 'pending' | 'accepted' | 'rejected';
export type FollowNetwork = 'activitypub' | 'atproto';

export interface IFederatedFollow extends Document {
  localUserId: string;
  remoteActorUri: string;
  direction: FollowDirection;
  status: FollowStatus;
  /**
   * The external network this follow edge targets. Defaults to ActivityPub
   * (every existing row); atproto follows are recorded as a local subscription
   * (`direction:'outbound', status:'accepted', network:'atproto'`) that backfills
   * the actor's posts without delivering a Follow over the wire.
   */
  network: FollowNetwork;
  activityId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FederatedFollowSchema = new Schema<IFederatedFollow>({
  localUserId: { type: String, required: true, index: true },
  remoteActorUri: { type: String, required: true, index: true },
  direction: { type: String, required: true, enum: ['outbound', 'inbound'], index: true },
  status: { type: String, default: 'pending', enum: ['pending', 'accepted', 'rejected'], index: true },
  network: { type: String, enum: ['activitypub', 'atproto'], default: 'activitypub' },
  activityId: { type: String },
}, {
  timestamps: true,
});

FederatedFollowSchema.index({ localUserId: 1, remoteActorUri: 1, direction: 1 }, { unique: true });
FederatedFollowSchema.index({ localUserId: 1, direction: 1, status: 1 });
FederatedFollowSchema.index({ remoteActorUri: 1, direction: 1 });

export const FederatedFollow = mongoose.model<IFederatedFollow>('FederatedFollow', FederatedFollowSchema);
export default FederatedFollow;
