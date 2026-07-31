import UserSettings, { type UserSettingsData } from '../models/UserSettings';
import { resolveBannerUrl } from './mediaResolver';

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

/**
 * The public design DTO carries a FINAL, banner-sized URL. It must go through
 * `resolveBannerUrl` and not `resolveMediaRef(...).url`: the latter's `url` is
 * the no-variant ORIGINAL, so the profile screen was rendering the raw upload
 * (megabytes of camera-roll PNG) into a 170px-tall strip.
 */
function resolveProfileHeaderImage(value: unknown): string | undefined {
  const ref = nonEmptyString(value);
  if (!ref) return undefined;

  return resolveBannerUrl(ref);
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
    // Pinned Syra "profile media" (a song OR a podcast show) — already
    // denormalized + verified at save time, so it is public-safe and
    // rendered/played by viewers as-is. Normalize the stored `null` default to
    // `undefined` so the DTO omits it.
    profileMedia: customization.profileMedia ?? undefined,
  };
}

/**
 * The profile-design DTO with every design field suppressed — what a viewer
 * without profile access receives. Sharing this list means a design field added
 * to {@link extractPublicProfileData} cannot be redacted on one profile surface
 * and forgotten on the other.
 */
export function redactedProfileDesign(userId: string) {
  return {
    oxyUserId: userId,
    appearance: undefined,
    profileHeaderImage: undefined,
    profileCustomization: undefined,
    profileMedia: undefined,
  };
}

/**
 * Returns the appropriate settings payload for a viewer.
 *
 * Full settings documents include private preferences (for example NSFW opt-in
 * and hidden words) and must only be returned to the settings owner. Other
 * authenticated viewers receive the same public-safe profile data used by
 * profile surfaces.
 *
 * `canViewProfileDesign` is REQUIRED, not optional: the design fields are gated
 * on the target's `privacy.profileVisibility`, and a permissive default is
 * exactly how the next call site would silently reopen the bypass this closed.
 * Resolve it with `canViewProfileDesign` from `utils/privacyHelpers` — the same
 * rule `GET /profile/design/:userId` applies.
 */
export function buildSettingsResponseForViewer(
  doc: Partial<UserSettingsData> | null | undefined,
  targetUserId: string,
  viewerUserId: string,
  options: { canViewProfileDesign: boolean },
) {
  if (targetUserId === viewerUserId) {
    return doc;
  }

  if (!options.canViewProfileDesign) {
    return redactedProfileDesign(targetUserId);
  }

  return extractPublicProfileData(doc, targetUserId);
}
