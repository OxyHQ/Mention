/**
 * Which of a post author's engagement counters may be shown at all.
 *
 * The four flags live on `UserSettings.privacy` and belong to the POST'S AUTHOR,
 * not to the viewer — an author who hides like counts hides them from everyone.
 * `PostHydrationService` turns a hidden counter into `null` on the DTO; the
 * realtime broadcaster omits it from the wire, and the engagement write responses
 * answer it as `null`. All three read the flags through here
 * so a fifth counter, or a renamed flag, cannot land in one surface only.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import { logger } from '../utils/logger';

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

/**
 * The post author's flags, read fresh. A missing author, a missing row and a
 * failed read all resolve to the defaults, for the reason given on
 * {@link readEngagementCountPrivacy}.
 */
export async function loadEngagementCountPrivacy(
  authorOxyUserId: string | null | undefined,
): Promise<EngagementCountPrivacy> {
  if (!authorOxyUserId) return { ...DEFAULT_PRIVACY };
  try {
    const [settings] = await getDb()
      .select({
        hideLikeCounts: userSettings.privacyHideLikeCounts,
        hideShareCounts: userSettings.privacyHideShareCounts,
        hideReplyCounts: userSettings.privacyHideReplyCounts,
        hideSaveCounts: userSettings.privacyHideSaveCounts,
      })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, authorOxyUserId))
      .limit(1);
    return readEngagementCountPrivacy(settings);
  } catch (error) {
    logger.warn('[EngagementCountPrivacy] Failed to load author count privacy', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_PRIVACY };
  }
}

/** Engagement counters, named the way the models name them. */
export interface EngagementCounts {
  likes?: number;
  downvotes?: number;
  boosts?: number;
  replies?: number;
  saves?: number;
}

/**
 * The counters as the author allows them to be shown: a hidden one is `null`.
 *
 * Likes and downvotes are two faces of one vote and share one control, so a vote
 * reports both or neither. A counter the caller did not supply stays absent.
 */
export function visibleEngagementCounts(
  counts: EngagementCounts,
  privacy: EngagementCountPrivacy,
): { [K in keyof EngagementCounts]: number | null } {
  const visible: { [K in keyof EngagementCounts]: number | null } = {};
  const hidden: Record<keyof EngagementCounts, boolean> = {
    likes: privacy.hideLikeCounts,
    downvotes: privacy.hideLikeCounts,
    boosts: privacy.hideShareCounts,
    replies: privacy.hideReplyCounts,
    saves: privacy.hideSaveCounts,
  };
  for (const key of Object.keys(hidden) as Array<keyof EngagementCounts>) {
    const count = counts[key];
    if (typeof count === 'number') visible[key] = hidden[key] ? null : count;
  }
  return visible;
}
