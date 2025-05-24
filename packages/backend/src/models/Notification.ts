import mongoose, { Document, Schema } from "mongoose";

export interface INotification extends Document {
  recipientId: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
  type: string;
  entityId: mongoose.Types.ObjectId;
  entityType: string;
  read: boolean;
  createdAt: Date;
}

const NotificationSchema = new Schema({
  recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    required: true,
    enum: ['like', 'reply', 'mention', 'follow', 'repost', 'quote', 'welcome']
  },
  entityId: { type: Schema.Types.ObjectId, required: true },
  entityType: { 
    type: String, 
    required: true,
    enum: ['post', 'reply', 'profile']
  },
  read: { type: Boolean, default: false },
}, { 
  timestamps: true 
});

// Index for quick lookups by recipient
NotificationSchema.index({ recipientId: 1, createdAt: -1 });
// Index for checking duplicates
NotificationSchema.index({ recipientId: 1, actorId: 1, type: 1, entityId: 1 }, { unique: true });

export default mongoose.model<INotification>("Notification", NotificationSchema);