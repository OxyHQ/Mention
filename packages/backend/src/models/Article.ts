import mongoose, { Document, Schema } from 'mongoose';

export interface IArticle extends Document {
  postId?: string;
  createdBy: string;
  title?: string;
  body?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ArticleSchema = new Schema<IArticle>({
  postId: { type: String, index: true },
  createdBy: { type: String, required: true, index: true },
  title: { type: String, trim: true, maxlength: 280 },
  body: { type: String, trim: true },
}, {
  timestamps: true,
});

export default mongoose.models.Article || mongoose.model<IArticle>('Article', ArticleSchema);

