import mongoose, { Document, Schema } from "mongoose";

export interface IPost extends Document {
  text: string;
  userID: mongoose.Types.ObjectId;
  media: string[];
  hashtags: string[];
  mentions: string[];
  quoted_post_id: mongoose.Types.ObjectId | null;
  quoted_post: mongoose.Types.ObjectId | null;
  repost_of: mongoose.Types.ObjectId | null;
  in_reply_to_status_id: mongoose.Types.ObjectId | null;
  source: string;
  possibly_sensitive: boolean;
  lang: string;
  created_at: Date;
  updated_at: Date;
  metadata?: string;
  replies: mongoose.Types.ObjectId[];
  likes: mongoose.Types.ObjectId[];
  reposts: mongoose.Types.ObjectId[];
  bookmarks: mongoose.Types.ObjectId[];
  _count?: {
    replies: number;
    likes: number;
    reposts: number;
    bookmarks: number;
  };
  isDraft: boolean;
  scheduledFor: Date | null;
  status: 'draft' | 'scheduled' | 'published';
}

const PostSchema = new Schema<IPost>({
  text: { type: String, required: true },
  userID: { type: Schema.Types.ObjectId, required: true },
  media: [{ type: String }],
  hashtags: [{ type: Schema.Types.ObjectId, ref: 'Hashtag' }],
  mentions: [{ type: Schema.Types.ObjectId }],
  quoted_post_id: { type: Schema.Types.ObjectId, ref: 'Post', default: null },
  quoted_post: { type: Schema.Types.ObjectId, ref: 'Post', default: null },
  repost_of: { type: Schema.Types.ObjectId, ref: 'Post', default: null },
  in_reply_to_status_id: { type: Schema.Types.ObjectId, ref: 'Post', default: null },
  source: { type: String, default: 'web' },
  possibly_sensitive: { type: Boolean, default: false },
  lang: { type: String, default: 'en' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  metadata: { type: String },
  replies: [{ type: Schema.Types.ObjectId, ref: 'Post' }],
  likes: [{ type: Schema.Types.ObjectId }],
  reposts: [{ type: Schema.Types.ObjectId }],
  bookmarks: [{ type: Schema.Types.ObjectId }],
  isDraft: { type: Boolean, default: false },
  scheduledFor: { type: Date, default: null },
  status: { type: String, enum: ['draft', 'scheduled', 'published'], default: 'published' }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  toObject: { virtuals: true },
  toJSON: { virtuals: true }
});

// Virtual fields for counts
PostSchema.virtual('_count').get(function() {
  return {
    replies: this.replies?.length || 0,
    likes: this.likes?.length || 0,
    reposts: this.reposts?.length || 0,
    bookmarks: this.bookmarks?.length || 0
  };
});



// Indexes
PostSchema.index({ userID: 1, created_at: -1 });
PostSchema.index({ hashtags: 1, created_at: -1 });
PostSchema.index({ mentions: 1, created_at: -1 });
PostSchema.index({ in_reply_to_status_id: 1, created_at: -1 });
PostSchema.index({ quoted_post_id: 1 });
PostSchema.index({ repost_of: 1 });
PostSchema.index({ replies: 1 });
PostSchema.index({ likes: 1 });
PostSchema.index({ reposts: 1 });
PostSchema.index({ bookmarks: 1 });

export const Post = mongoose.model<IPost>('Post', PostSchema);
export default Post;
