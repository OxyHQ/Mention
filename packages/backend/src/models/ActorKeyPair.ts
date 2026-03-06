import mongoose, { Document, Schema } from 'mongoose';

export interface IActorKeyPair extends Document {
  oxyUserId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
  createdAt: Date;
  updatedAt: Date;
}

const ActorKeyPairSchema = new Schema<IActorKeyPair>({
  oxyUserId: { type: String, required: true, unique: true, index: true },
  publicKeyPem: { type: String, required: true },
  privateKeyPem: { type: String, required: true },
  keyId: { type: String, required: true },
}, {
  timestamps: true,
});

export const ActorKeyPair = mongoose.model<IActorKeyPair>('ActorKeyPair', ActorKeyPairSchema);
export default ActorKeyPair;
