import UserSettings from '../models/UserSettings';
import { resolveMediaRef } from './mediaResolver';

/**
 * Default profile customization settings
 */
export const DEFAULT_PROFILE_CUSTOMIZATION = {
  coverPhotoEnabled: true,
  minimalistMode: false,
} as const;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function resolveProfileHeaderImage(value: unknown): string | undefined {
  const ref = nonEmptyString(value);
  if (!ref) return undefined;

  return resolveMediaRef(ref).url || undefined;
}

/**
 * Ensures a UserSettings document exists for a user
 * Creates with defaults if missing, updates if missing profileCustomization
 */
export async function ensureUserSettings(oxyUserId: string) {
  let doc = await UserSettings.findOne({ oxyUserId }).lean();
  
  if (!doc) {
    const created = await UserSettings.create({ 
      oxyUserId,
      profileCustomization: DEFAULT_PROFILE_CUSTOMIZATION,
    });
    doc = created.toObject() as any;
  } else if (!doc.profileCustomization) {
    doc = await UserSettings.findOneAndUpdate(
      { oxyUserId },
      { $set: { profileCustomization: DEFAULT_PROFILE_CUSTOMIZATION } },
      { new: true }
    ).lean();
  }
  
  return doc;
}

/**
 * Extracts public profile design data from UserSettings document
 */
export function extractPublicProfileData(doc: any, userId: string) {
  const customization = doc?.profileCustomization || {};
  const displayName = nonEmptyString(customization.displayName);
  const profileCustomization = {
    coverPhotoEnabled:
      typeof customization.coverPhotoEnabled === 'boolean'
        ? customization.coverPhotoEnabled
        : DEFAULT_PROFILE_CUSTOMIZATION.coverPhotoEnabled,
    minimalistMode:
      typeof customization.minimalistMode === 'boolean'
        ? customization.minimalistMode
        : DEFAULT_PROFILE_CUSTOMIZATION.minimalistMode,
    ...(displayName && { displayName }),
  };

  return {
    oxyUserId: userId,
    appearance: doc?.appearance?.primaryColor ? {
      primaryColor: doc.appearance.primaryColor,
    } : undefined,
    profileHeaderImage: resolveProfileHeaderImage(doc?.profileHeaderImage),
    profileCustomization,
  };
}
