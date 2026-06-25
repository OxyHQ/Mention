import UserSettings, { type UserSettingsData } from '../models/UserSettings';
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
  let doc = await UserSettings.findOne({ oxyUserId }).lean<UserSettingsData>().exec();
  
  if (!doc) {
    const created = await UserSettings.create({ 
      oxyUserId,
      profileCustomization: DEFAULT_PROFILE_CUSTOMIZATION,
    });
    doc = created.toObject<UserSettingsData>();
  } else if (!doc.profileCustomization) {
    doc = await UserSettings.findOneAndUpdate(
      { oxyUserId },
      { $set: { profileCustomization: DEFAULT_PROFILE_CUSTOMIZATION } },
      { new: true }
    ).lean<UserSettingsData>().exec();
  }
  
  return doc;
}

/**
 * Extracts public profile design data from UserSettings document
 */
export function extractPublicProfileData(doc: Partial<UserSettingsData> | null | undefined, userId: string) {
  const customization = doc?.profileCustomization || {};
  const profileCustomization = {
    coverPhotoEnabled:
      typeof customization.coverPhotoEnabled === 'boolean'
        ? customization.coverPhotoEnabled
        : DEFAULT_PROFILE_CUSTOMIZATION.coverPhotoEnabled,
    minimalistMode:
      typeof customization.minimalistMode === 'boolean'
        ? customization.minimalistMode
        : DEFAULT_PROFILE_CUSTOMIZATION.minimalistMode,
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

/**
 * Returns the appropriate settings payload for a viewer.
 *
 * Full settings documents include private preferences (for example NSFW opt-in
 * and hidden words) and must only be returned to the settings owner. Other
 * authenticated viewers receive the same public-safe profile data used by
 * profile surfaces.
 */
export function buildSettingsResponseForViewer(
  doc: Partial<UserSettingsData> | null | undefined,
  targetUserId: string,
  viewerUserId: string,
) {
  if (targetUserId === viewerUserId) {
    return doc;
  }

  return extractPublicProfileData(doc, targetUserId);
}
