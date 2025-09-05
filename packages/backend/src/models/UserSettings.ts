import mongoose, { Schema, Document } from 'mongoose';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
}

export interface IUserSettings extends Document {
  oxyUserId: string;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AppearanceSchema = new Schema<AppearanceSettings>({
  themeMode: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
  primaryColor: { type: String, default: undefined },
}, { _id: false });

const UserSettingsSchema = new Schema<IUserSettings>({
  oxyUserId: { type: String, required: true, index: true, unique: true },
  appearance: { type: AppearanceSchema, default: () => ({ themeMode: 'system' }) },
  profileHeaderImage: { type: String },
}, { timestamps: true, versionKey: false });

export const UserSettings = mongoose.model<IUserSettings>('UserSettings', UserSettingsSchema);

export default UserSettings;

