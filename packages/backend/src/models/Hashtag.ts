import mongoose, { Schema, Document } from 'mongoose';

export interface IHashtag extends Document {
    name: string;
    count: number;
    created_at: Date;
    updated_at: Date;
}

const HashtagSchema = new Schema<IHashtag>({
    name: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 }
}, {
    timestamps: {
        createdAt: 'created_at',
        updatedAt: 'updated_at'
    }
});

// Indexes
// Removing redundant index on 'name' as it's already indexed by 'unique: true' in the schema
HashtagSchema.index({ count: -1 });

export default mongoose.model<IHashtag>('Hashtag', HashtagSchema);