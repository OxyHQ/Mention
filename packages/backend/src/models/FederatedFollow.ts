import mongoose, { Document, Schema } from 'mongoose';

export type FollowDirection = 'outbound' | 'inbound';
export type FollowStatus = 'pending' | 'accepted' | 'rejected';

export interface IFederatedFollow extends Document {
  localUserId: string;
  remoteActorUri: string;
  direction: FollowDirection;
  status: FollowStatus;
  activityId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FederatedFollowSchema = new Schema<IFederatedFollow>({
  localUserId: { type: String, required: true, index: true },
  remoteActorUri: { type: String, required: true, index: true },
  direction: { type: String, required: true, enum: ['outbound', 'inbound'], index: true },
  status: { type: String, default: 'pending', enum: ['pending', 'accepted', 'rejected'], index: true },
  activityId: { type: String },
}, {
  timestamps: true,
});

FederatedFollowSchema.index({ localUserId: 1, remoteActorUri: 1, direction: 1 }, { unique: true });
FederatedFollowSchema.index({ localUserId: 1, direction: 1, status: 1 });
FederatedFollowSchema.index({ remoteActorUri: 1, direction: 1 });

export const FederatedFollow = mongoose.model<IFederatedFollow>('FederatedFollow', FederatedFollowSchema);
export default FederatedFollow;
