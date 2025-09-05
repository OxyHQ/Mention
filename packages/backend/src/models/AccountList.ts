import mongoose, { Schema, Document } from 'mongoose';

export interface IAccountList extends Document {
  ownerOxyUserId: string;
  title: string;
  description?: string;
  isPublic: boolean;
  memberOxyUserIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const AccountListSchema = new Schema<IAccountList>({
  ownerOxyUserId: { type: String, required: true, index: true },
  title: { type: String, required: true },
  description: { type: String },
  isPublic: { type: Boolean, default: true },
  memberOxyUserIds: { type: [String], default: [] },
}, { timestamps: true });

AccountListSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
AccountListSchema.index({ isPublic: 1, createdAt: -1 });

export const AccountList = mongoose.model<IAccountList>('AccountList', AccountListSchema);
export default AccountList;

