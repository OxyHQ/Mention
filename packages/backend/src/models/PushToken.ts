import mongoose, { Schema, Document } from 'mongoose';

export interface IPushToken extends Document {
  userId: string; // Oxy user id
  token: string; // FCM/APNs device token
  type: 'fcm' | 'apns' | 'unknown';
  platform: 'android' | 'ios' | 'unknown';
  deviceId?: string;
  locale?: string;
  enabled: boolean;
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PushTokenSchema = new Schema<IPushToken>({
  userId: { type: String, required: true, index: true },
  token: { type: String, required: true, unique: true, index: true },
  type: { type: String, enum: ['fcm', 'apns', 'unknown'], default: 'unknown' },
  platform: { type: String, enum: ['android', 'ios', 'unknown'], default: 'unknown' },
  deviceId: { type: String },
  locale: { type: String },
  enabled: { type: Boolean, default: true },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

PushTokenSchema.index({ userId: 1, token: 1 }, { unique: true });

export default mongoose.model<IPushToken>('PushToken', PushTokenSchema);
