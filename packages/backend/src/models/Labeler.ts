import mongoose, { Schema, Document } from 'mongoose';

export interface ILabelDefinition {
  slug: string;
  name: string;
  description?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  defaultAction: 'show' | 'warn' | 'blur' | 'hide';
}

export interface ILabeler extends Document {
  name: string;
  description?: string;
  creatorId: string;
  isOfficial: boolean;
  labelDefinitions: ILabelDefinition[];
  subscriberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const LabelDefinitionSchema = new Schema<ILabelDefinition>({
  slug: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String },
  severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
  defaultAction: { type: String, enum: ['show', 'warn', 'blur', 'hide'], required: true },
}, { _id: false });

const LabelerSchema = new Schema<ILabeler>({
  name: { type: String, required: true },
  description: { type: String },
  creatorId: { type: String, required: true, index: true },
  isOfficial: { type: Boolean, default: false },
  labelDefinitions: { type: [LabelDefinitionSchema], default: [] },
  subscriberCount: { type: Number, default: 0 },
}, { timestamps: true });

export const Labeler = mongoose.model<ILabeler>('Labeler', LabelerSchema);
export default Labeler;
