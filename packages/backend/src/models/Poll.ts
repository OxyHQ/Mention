import mongoose, { Document, Schema } from "mongoose";
import { IPost } from './Post';

export interface IPollOption extends Document {
  text: string;
  votes: mongoose.Types.ObjectId[]; // User IDs who voted for this option
}

export interface IPoll extends Document {
  question: string;
  options: IPollOption[];
  postId: string | IPost['_id']; // Allow string for temporary IDs
  createdBy: mongoose.Types.ObjectId;
  endsAt: Date;
  isMultipleChoice: boolean;
  isAnonymous: boolean;
  created_at: Date;
  updated_at: Date;
}

const PollOptionSchema = new Schema<IPollOption>({
  text: { type: String, required: true },
  votes: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { _id: true });

const PollSchema = new Schema<IPoll>({
  question: { type: String, required: true },
  options: [PollOptionSchema],
  postId: { 
    type: Schema.Types.Mixed, // Use Mixed type to allow both ObjectId and String
    required: true,
    validate: {
      validator: function(v: any) {
        // Allow both ObjectId and strings that start with 'temp_'
        return mongoose.Types.ObjectId.isValid(v) || (typeof v === 'string' && v.startsWith('temp_'));
      },
      message: props => `${props.value} is not a valid ObjectId or temporary ID!`
    }
  },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  endsAt: { type: Date, required: true },
  isMultipleChoice: { type: Boolean, default: false },
  isAnonymous: { type: Boolean, default: false }
}, {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
});

// Virtual for total votes
PollSchema.virtual('totalVotes').get(function() {
  return this.options.reduce((total, option) => total + option.votes.length, 0);
});

// Indexes
PollSchema.index({ createdBy: 1 });
PollSchema.index({ endsAt: 1 });
// Only index postId if it's a valid ObjectId
PollSchema.index({ 
  postId: 1 
}, {
  partialFilterExpression: {
    postId: { $type: 'objectId' }
  }
});

export const Poll = mongoose.model<IPoll>('Poll', PollSchema);
export default Poll; 