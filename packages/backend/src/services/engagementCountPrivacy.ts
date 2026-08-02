/**
 * Which of a post author's engagement counters may be shown at all.
 *
 * The four flags live on `UserSettings.privacy` and belong to the POST'S AUTHOR,
 * not to the viewer — an author who hides like counts hides them from everyone.
 * `PostHydrationService` turns a hidden counter into `null` on the DTO; the
 * realtime broadcaster omits it from the wire. Both read the flags through here
 * so a fifth counter, or a renamed flag, cannot land in one surface only.
 */
export const DEFAULT_PRIVACY = {
  hideLikeCounts: false,
  hideShareCounts: false,
  hideReplyCounts: false,
  hideSaveCounts: false,
};

export type EngagementCountPrivacy = typeof DEFAULT_PRIVACY;

/** The `privacy` subdocument of a `UserSettings` row, as far as counters care. */
interface CountPrivacySource {
  hideLikeCounts?: boolean;
  hideShareCounts?: boolean;
  hideReplyCounts?: boolean;
  hideSaveCounts?: boolean;
}

/**
 * Read the four flags off a settings row.
 *
 * An absent row means an author who never opened the setting, which is the
 * default and the overwhelming majority — hence "show", matching what the DTO
 * has always served. A read that FAILED resolves to the same value on purpose:
 * the render path already falls back to defaults on a settings-load error, so
 * doing anything else here would make the live number and the reloaded number
 * disagree about the same failure.
 */
export function readEngagementCountPrivacy(
  privacy: CountPrivacySource | null | undefined,
): EngagementCountPrivacy {
  return {
    hideLikeCounts: Boolean(privacy?.hideLikeCounts),
    hideShareCounts: Boolean(privacy?.hideShareCounts),
    hideReplyCounts: Boolean(privacy?.hideReplyCounts),
    hideSaveCounts: Boolean(privacy?.hideSaveCounts),
  };
}
