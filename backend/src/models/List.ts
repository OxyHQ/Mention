import mongoose, { Schema, Document } from 'mongoose';

export interface IList extends Document {
    userId: string;
    name: string;
    created_at: Date;
    posts: string[];
}

const ListSchema: Schema = new Schema({
    userId: { type: String, required: true },
    name: { type: String, required: true },
    created_at: { type: Date, default: Date.now },
    posts: [{ type: Schema.Types.ObjectId, ref: 'Post' }],
});

export default mongoose.model<IList>('List', ListSchema);
