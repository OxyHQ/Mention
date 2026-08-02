/**
 * The ONE read/write path for `user_settings`.
 *
 * ## What this exists to close
 *
 * `user_settings` was SPLIT across two stores. Four writers
 * (`ensureUserSettings`, the settings PUT, the feed-tuning PUT, the federated
 * banner import) wrote the Mongoose model, while six readers — `viewerSafety`,
 * `PostHydrationService`, `actorObject`, `ContentAffinityService`,
 * `statistics.controller` and `userSources` — already read the Postgres table.
 * Two self-consistent halves: the Mongo writers agreed with the Mongo readers,
 * and the Postgres readers observed an empty table. A user's sensitive-content
 * opt-in was written where nothing that enforces it could see it.
 *
 * The failure mode is why this is a repository rather than eleven ported call
 * sites: nothing errors. A preference silently does not take effect, and the
 * only thing that catches that is a read-after-write test — which is what
 * `__tests__/db/userSettingsRepository.test.ts` and the reader suites do.
 *
 * ## The dotted-path map is the dangerous part, and it FAILS LOUD
 *
 * The settings PUT builds a Mongo `$set`/`$unset` map of DOTTED paths
 * (`privacy.showSensitiveContent`, `feedSettings.diversity.enabled`). A dot path
 * handed to drizzle's `set()` is an unknown property that drizzle **silently
 * ignores** — the write does nothing and throws nothing, which is the exact
 * failure this port is meant to end, reintroduced one layer down.
 *
 * So {@link SETTINGS_COLUMN_BY_PATH} is an explicit, total map and an unknown
 * path THROWS. A new setting that forgets to register its path fails on its
 * first write instead of being quietly dropped forever.
 */

import { eq, inArray } from 'drizzle-orm';
import { EXTERNAL_EMBED_SOURCES, type ExternalEmbedsSettings, type FeedTuning } from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { userSettings, userSettingsLabelActions } from '../schema/userProfile';
import type {
  LabelAction,
  ProfileMedia,
  UserSettingsRecord,
} from './userSettingsRecord';

type SettingsRow = typeof userSettings.$inferSelect;
type SettingsInsert = typeof userSettings.$inferInsert;
/** Every column a caller may write. `id`/`oxyUserId`/timestamps are ours. */
type WritableColumn = Exclude<keyof SettingsInsert, 'id' | 'oxyUserId' | 'createdAt' | 'updatedAt'>;

/**
 * Mongo dot path → column, for every path any writer can produce.
 *
 * Deliberately explicit rather than derived from a naming convention: the
 * prefixes do not follow one (`privacy.*` → `privacy*`, but
 * `profileCustomization.*` → `profile*`, `notificationPreferences.*` →
 * `notify*`, `feedSettings.diversity.*` → `feed*`), and a convention that is
 * right four times out of five silently drops the fifth.
 *
 * `profileCustomization.profileMedia` and `feedTuning.forYou` are absent on
 * purpose — they are whole OBJECTS spanning several columns each, handled by
 * {@link expandObjectPath}.
 */
export const SETTINGS_COLUMN_BY_PATH: Readonly<Record<string, WritableColumn>> = Object.freeze({
  'appearance.themeMode': 'appearanceThemeMode',
  'appearance.primaryColor': 'appearancePrimaryColor',
  'appearance.postTextExpand': 'appearancePostTextExpand',
  'appearance.postReadMoreAction': 'appearancePostReadMoreAction',
  'appearance.collapseLongBio': 'appearanceCollapseLongBio',

  profileHeaderImage: 'profileHeaderImage',
  fediversePreferredLanguage: 'fediversePreferredLanguage',

  'privacy.profileVisibility': 'privacyProfileVisibility',
  'privacy.showContactInfo': 'privacyShowContactInfo',
  'privacy.allowTags': 'privacyAllowTags',
  'privacy.allowMentions': 'privacyAllowMentions',
  'privacy.showOnlineStatus': 'privacyShowOnlineStatus',
  'privacy.hideLikeCounts': 'privacyHideLikeCounts',
  'privacy.hideShareCounts': 'privacyHideShareCounts',
  'privacy.hideReplyCounts': 'privacyHideReplyCounts',
  'privacy.hideSaveCounts': 'privacyHideSaveCounts',
  'privacy.showSensitiveContent': 'privacyShowSensitiveContent',
  'privacy.hiddenWords': 'privacyHiddenWords',
  'privacy.restrictedUsers': 'privacyRestrictedUsers',
  'privacy.labelPreferences.subscribedLabelers': 'privacySubscribedLabelers',

  'profileCustomization.coverPhotoEnabled': 'profileCoverPhotoEnabled',
  'profileCustomization.minimalistMode': 'profileMinimalistMode',

  'interests.tags': 'interestTags',

  'feedSettings.diversity.enabled': 'feedDiversityEnabled',
  'feedSettings.diversity.sameAuthorPenalty': 'feedSameAuthorPenalty',
  'feedSettings.diversity.sameTopicPenalty': 'feedSameTopicPenalty',
  'feedSettings.diversity.maxConsecutiveSameAuthor': 'feedMaxConsecutiveSameAuthor',
  'feedSettings.recency.halfLifeHours': 'feedRecencyHalfLifeHours',
  'feedSettings.recency.maxAgeHours': 'feedRecencyMaxAgeHours',
  'feedSettings.quality.minEngagementRate': 'feedMinEngagementRate',
  'feedSettings.quality.boostHighQuality': 'feedBoostHighQuality',

  'notificationPreferences.pushEnabled': 'notifyPushEnabled',
  'notificationPreferences.emailEnabled': 'notifyEmailEnabled',
  'notificationPreferences.likes': 'notifyLikes',
  'notificationPreferences.boosts': 'notifyBoosts',
  'notificationPreferences.follows': 'notifyFollows',
  'notificationPreferences.mentions': 'notifyMentions',
  'notificationPreferences.replies': 'notifyReplies',
  'notificationPreferences.quotes': 'notifyQuotes',

  'externalEmbeds.youtube': 'embedYoutube',
  'externalEmbeds.youtubeShorts': 'embedYoutubeShorts',
  'externalEmbeds.vimeo': 'embedVimeo',
  'externalEmbeds.twitch': 'embedTwitch',
  'externalEmbeds.giphy': 'embedGiphy',
  'externalEmbeds.spotify': 'embedSpotify',
  'externalEmbeds.appleMusic': 'embedAppleMusic',
  'externalEmbeds.soundcloud': 'embedSoundcloud',
  'externalEmbeds.flickr': 'embedFlickr',
  'externalEmbeds.bandcamp': 'embedBandcamp',
});

/**
 * What a column becomes when its path is `$unset`.
 *
 * `NULL` is what "absent" means for a NULLABLE column, and it is what the Mongo
 * `$unset` produced. A column that is `NOT NULL` with a default cannot express
 * absence at all, so unsetting it restores the DEFAULT — which is the value a
 * document that never carried the field read back as under Mongoose's own
 * schema defaults. Anything else would make "clear this setting" mean something
 * the user never asked for.
 */
const UNSET_VALUE: Readonly<Partial<Record<WritableColumn, unknown>>> = Object.freeze({
  appearanceThemeMode: 'system',
  appearancePostTextExpand: 'default',
  appearancePostReadMoreAction: 'openPost',
  appearanceCollapseLongBio: true,
  privacyProfileVisibility: 'public',
  privacyShowContactInfo: true,
  privacyAllowTags: true,
  privacyAllowMentions: true,
  privacyShowOnlineStatus: true,
  privacyHideLikeCounts: false,
  privacyHideShareCounts: false,
  privacyHideReplyCounts: false,
  privacyHideSaveCounts: false,
  privacyShowSensitiveContent: false,
  profileCoverPhotoEnabled: true,
  profileMinimalistMode: false,
  feedDiversityEnabled: true,
  feedSameAuthorPenalty: 0.95,
  feedSameTopicPenalty: 0.92,
  feedRecencyHalfLifeHours: 24,
  feedRecencyMaxAgeHours: 168,
  feedBoostHighQuality: true,
  notifyPushEnabled: true,
  notifyEmailEnabled: false,
  notifyLikes: true,
  notifyBoosts: true,
  notifyFollows: true,
  notifyMentions: true,
  notifyReplies: true,
  notifyQuotes: true,
});

/** The columns `profileCustomization.profileMedia` owns, all of them. */
const PROFILE_MEDIA_COLUMNS: readonly WritableColumn[] = [
  'profileMediaType',
  'profileMediaTitle',
  'profileMediaArtworkUrl',
  'profileMediaSyraTrackId',
  'profileMediaArtist',
  'profileMediaPreviewUrl',
  'profileMediaStartSec',
  'profileMediaDurationSec',
  'profileMediaSyraPodcastId',
  'profileMediaAuthor',
  'profileMediaShowUrl',
];

/** The columns `feedTuning.forYou` owns, all of them. */
const FEED_TUNING_COLUMNS: readonly WritableColumn[] = [
  'tuningMinLengthEnabled',
  'tuningMinLength',
  'tuningLowEffortGateEnabled',
  'tuningMinMeaningfulTextLength',
  'tuningNativeEngagementEnabled',
  'tuningMinNativeEngagement',
  'tuningMinQualityEnabled',
  'tuningMinQuality',
];

/** Every profile-media column cleared — one media item REPLACES the other. */
function clearedProfileMedia(): Partial<SettingsInsert> {
  return Object.fromEntries(
    PROFILE_MEDIA_COLUMNS.map((column) => [column, null]),
  ) as Partial<SettingsInsert>;
}

/**
 * Expand a whole-object path into its columns.
 *
 * Both objects here span several columns that a partial write would leave
 * inconsistent — a song's `syraTrackId` surviving on a row that now holds a
 * podcast, say — so each one is written as a COMPLETE set with the other
 * variant's columns cleared. Returns `undefined` when `path` is not one of them.
 */
function expandObjectPath(path: string, value: unknown): Partial<SettingsInsert> | undefined {
  if (path === 'profileCustomization.profileMedia') {
    const cleared = clearedProfileMedia();
    if (value == null) return cleared;
    const media = value as ProfileMedia;
    if (media.type === 'song') {
      return {
        ...cleared,
        profileMediaType: 'song',
        profileMediaTitle: media.title,
        profileMediaArtworkUrl: media.artworkUrl ?? null,
        profileMediaSyraTrackId: media.syraTrackId,
        profileMediaArtist: media.artist,
        profileMediaPreviewUrl: media.previewUrl,
        profileMediaStartSec: media.startSec,
        profileMediaDurationSec: media.durationSec ?? null,
      };
    }
    return {
      ...cleared,
      profileMediaType: 'podcast',
      profileMediaTitle: media.title,
      profileMediaArtworkUrl: media.artworkUrl ?? null,
      profileMediaSyraPodcastId: media.syraPodcastId,
      profileMediaAuthor: media.author ?? null,
      profileMediaShowUrl: media.showUrl,
    };
  }

  if (path === 'feedTuning.forYou') {
    const cleared = Object.fromEntries(
      FEED_TUNING_COLUMNS.map((column) => [column, null]),
    ) as Partial<SettingsInsert>;
    if (value == null) return cleared;
    const tuning = value as NonNullable<FeedTuning['forYou']>;
    return {
      ...cleared,
      tuningMinLengthEnabled: tuning.minLength?.enabled ?? null,
      tuningMinLength: tuning.minLength?.minLength ?? null,
      tuningLowEffortGateEnabled: tuning.lowEffortGate?.enabled ?? null,
      tuningMinMeaningfulTextLength: tuning.lowEffortGate?.minMeaningfulTextLength ?? null,
      tuningNativeEngagementEnabled: tuning.nativeEngagement?.enabled ?? null,
      tuningMinNativeEngagement: tuning.nativeEngagement?.minNativeEngagement ?? null,
      tuningMinQualityEnabled: tuning.minQuality?.enabled ?? null,
      tuningMinQuality: tuning.minQuality?.minQuality ?? null,
    };
  }

  return undefined;
}

/** Raised when a writer names a path no column is registered for. */
export class UnknownSettingsPathError extends Error {
  constructor(path: string) {
    super(
      `[userSettings] no column registered for "${path}". Register it in `
      + 'SETTINGS_COLUMN_BY_PATH — an unregistered path would be dropped silently.',
    );
    this.name = 'UnknownSettingsPathError';
  }
}

/** Translate one dotted `$set` / `$unset` pair into column values. */
function columnsForPath(path: string, value: unknown, unset: boolean): Partial<SettingsInsert> {
  const expanded = expandObjectPath(path, unset ? null : value);
  if (expanded) return expanded;

  const column = SETTINGS_COLUMN_BY_PATH[path];
  if (!column) throw new UnknownSettingsPathError(path);

  const resolved = unset ? (UNSET_VALUE[column] ?? null) : value;
  return { [column]: resolved } as Partial<SettingsInsert>;
}

/** Assemble the flat row (plus its label actions) into the nested record. */
function assembleRecord(row: SettingsRow, labelActions: LabelAction[]): UserSettingsRecord {
  const externalEmbeds: ExternalEmbedsSettings = {};
  for (const source of EXTERNAL_EMBED_SOURCES) {
    const column = SETTINGS_COLUMN_BY_PATH[`externalEmbeds.${source}`];
    const value = column ? row[column as keyof SettingsRow] : undefined;
    if (value === 'show' || value === 'hide') externalEmbeds[source] = value;
  }

  // The DISCRIMINATOR decides which variant the shared columns hold. Reading a
  // variant-specific column to decide would surface a replaced item's leftovers.
  let profileMedia: ProfileMedia | null = null;
  if (row.profileMediaType === 'song') {
    profileMedia = {
      type: 'song',
      syraTrackId: row.profileMediaSyraTrackId ?? '',
      title: row.profileMediaTitle ?? '',
      artist: row.profileMediaArtist ?? '',
      ...(row.profileMediaArtworkUrl ? { artworkUrl: row.profileMediaArtworkUrl } : {}),
      previewUrl: row.profileMediaPreviewUrl ?? '',
      startSec: row.profileMediaStartSec ?? 0,
      ...(row.profileMediaDurationSec == null ? {} : { durationSec: row.profileMediaDurationSec }),
    };
  } else if (row.profileMediaType === 'podcast') {
    profileMedia = {
      type: 'podcast',
      syraPodcastId: row.profileMediaSyraPodcastId ?? '',
      title: row.profileMediaTitle ?? '',
      ...(row.profileMediaAuthor ? { author: row.profileMediaAuthor } : {}),
      ...(row.profileMediaArtworkUrl ? { artworkUrl: row.profileMediaArtworkUrl } : {}),
      showUrl: row.profileMediaShowUrl ?? '',
    };
  }

  const forYou = {
    ...(row.tuningMinLengthEnabled == null && row.tuningMinLength == null ? {} : {
      minLength: {
        ...(row.tuningMinLengthEnabled == null ? {} : { enabled: row.tuningMinLengthEnabled }),
        ...(row.tuningMinLength == null ? {} : { minLength: row.tuningMinLength }),
      },
    }),
    ...(row.tuningLowEffortGateEnabled == null && row.tuningMinMeaningfulTextLength == null ? {} : {
      lowEffortGate: {
        ...(row.tuningLowEffortGateEnabled == null ? {} : { enabled: row.tuningLowEffortGateEnabled }),
        ...(row.tuningMinMeaningfulTextLength == null
          ? {}
          : { minMeaningfulTextLength: row.tuningMinMeaningfulTextLength }),
      },
    }),
    ...(row.tuningNativeEngagementEnabled == null && row.tuningMinNativeEngagement == null ? {} : {
      nativeEngagement: {
        ...(row.tuningNativeEngagementEnabled == null
          ? {}
          : { enabled: row.tuningNativeEngagementEnabled }),
        ...(row.tuningMinNativeEngagement == null
          ? {}
          : { minNativeEngagement: row.tuningMinNativeEngagement }),
      },
    }),
    ...(row.tuningMinQualityEnabled == null && row.tuningMinQuality == null ? {} : {
      minQuality: {
        ...(row.tuningMinQualityEnabled == null ? {} : { enabled: row.tuningMinQualityEnabled }),
        ...(row.tuningMinQuality == null ? {} : { minQuality: row.tuningMinQuality }),
      },
    }),
  };

  return {
    oxyUserId: row.oxyUserId,
    appearance: {
      themeMode: row.appearanceThemeMode,
      ...(row.appearancePrimaryColor ? { primaryColor: row.appearancePrimaryColor } : {}),
      postTextExpand: row.appearancePostTextExpand,
      postReadMoreAction: row.appearancePostReadMoreAction,
      collapseLongBio: row.appearanceCollapseLongBio,
    },
    ...(row.profileHeaderImage ? { profileHeaderImage: row.profileHeaderImage } : {}),
    privacy: {
      profileVisibility: row.privacyProfileVisibility,
      showContactInfo: row.privacyShowContactInfo,
      allowTags: row.privacyAllowTags,
      allowMentions: row.privacyAllowMentions,
      showOnlineStatus: row.privacyShowOnlineStatus,
      hideLikeCounts: row.privacyHideLikeCounts,
      hideShareCounts: row.privacyHideShareCounts,
      hideReplyCounts: row.privacyHideReplyCounts,
      hideSaveCounts: row.privacyHideSaveCounts,
      showSensitiveContent: row.privacyShowSensitiveContent,
      ...(row.privacyHiddenWords ? { hiddenWords: row.privacyHiddenWords } : {}),
      ...(row.privacyRestrictedUsers ? { restrictedUsers: row.privacyRestrictedUsers } : {}),
      labelPreferences: {
        subscribedLabelers: row.privacySubscribedLabelers ?? [],
        labelActions,
      },
    },
    profileCustomization: {
      coverPhotoEnabled: row.profileCoverPhotoEnabled,
      minimalistMode: row.profileMinimalistMode,
      profileMedia,
    },
    ...(row.interestTags ? { interests: { tags: row.interestTags } } : {}),
    feedSettings: {
      diversity: {
        enabled: row.feedDiversityEnabled,
        sameAuthorPenalty: row.feedSameAuthorPenalty,
        sameTopicPenalty: row.feedSameTopicPenalty,
        ...(row.feedMaxConsecutiveSameAuthor == null
          ? {}
          : { maxConsecutiveSameAuthor: row.feedMaxConsecutiveSameAuthor }),
      },
      recency: {
        halfLifeHours: row.feedRecencyHalfLifeHours,
        maxAgeHours: row.feedRecencyMaxAgeHours,
      },
      quality: {
        ...(row.feedMinEngagementRate == null
          ? {}
          : { minEngagementRate: row.feedMinEngagementRate }),
        boostHighQuality: row.feedBoostHighQuality,
      },
    },
    ...(Object.keys(forYou).length > 0 ? { feedTuning: { forYou } } : {}),
    notificationPreferences: {
      pushEnabled: row.notifyPushEnabled,
      emailEnabled: row.notifyEmailEnabled,
      likes: row.notifyLikes,
      boosts: row.notifyBoosts,
      follows: row.notifyFollows,
      mentions: row.notifyMentions,
      replies: row.notifyReplies,
      quotes: row.notifyQuotes,
    },
    ...(Object.keys(externalEmbeds).length > 0 ? { externalEmbeds } : {}),
    ...(row.fediversePreferredLanguage
      ? { fediversePreferredLanguage: row.fediversePreferredLanguage }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** One user's settings as stored, or `null` when they have never had a row. */
export async function loadUserSettings(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<UserSettingsRecord | null> {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.oxyUserId, oxyUserId));
  if (!row) return null;
  const actions = await db
    .select({
      labelerId: userSettingsLabelActions.labelerId,
      labelSlug: userSettingsLabelActions.labelSlug,
      action: userSettingsLabelActions.action,
    })
    .from(userSettingsLabelActions)
    .where(eq(userSettingsLabelActions.settingsId, row.id));
  return assembleRecord(row, actions);
}

/**
 * The user's settings row, creating it with defaults if absent.
 *
 * Every default lives in the SCHEMA, so an insert of nothing but the id
 * produces exactly the document `ensureUserSettings` used to create — there is
 * no second copy of the defaults here to drift from it.
 */
export async function ensureUserSettings(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<UserSettingsRecord> {
  await db.insert(userSettings).values({ oxyUserId }).onConflictDoNothing({
    target: userSettings.oxyUserId,
  });
  const record = await loadUserSettings(oxyUserId, db);
  if (!record) {
    // Unreachable via the upsert above; a throw is still correct because a
    // caller handed a missing record would write settings nobody can read.
    throw new Error(`[userSettings] row for ${oxyUserId} was not readable after ensure`);
  }
  return record;
}

/** A Mongo-shaped update, as the settings routes already build one. */
export interface UserSettingsUpdate {
  set?: Record<string, unknown>;
  unset?: Record<string, unknown>;
}

/**
 * Apply a dotted update and return the row as it now stands.
 *
 * Upserts, matching the `{ upsert: true, new: true }` every caller used: a user
 * who changes a setting before any row exists must end up with one.
 */
export async function updateUserSettings(
  oxyUserId: string,
  update: UserSettingsUpdate,
  db: DatabaseOrTransaction = getDb(),
): Promise<UserSettingsRecord> {
  let values: Partial<SettingsInsert> = {};
  for (const [path, value] of Object.entries(update.set ?? {})) {
    values = { ...values, ...columnsForPath(path, value, false) };
  }
  for (const path of Object.keys(update.unset ?? {})) {
    values = { ...values, ...columnsForPath(path, undefined, true) };
  }

  if (Object.keys(values).length === 0) return ensureUserSettings(oxyUserId, db);

  await db
    .insert(userSettings)
    .values({ oxyUserId, ...values })
    .onConflictDoUpdate({ target: userSettings.oxyUserId, set: values });

  const record = await loadUserSettings(oxyUserId, db);
  if (!record) {
    throw new Error(`[userSettings] row for ${oxyUserId} was not readable after update`);
  }
  return record;
}

/**
 * Replace a user's label actions wholesale.
 *
 * Delete-then-insert rather than a per-row diff: the set is small, the caller
 * always supplies the complete list, and a diff would have to reconcile a
 * composite natural key for no benefit.
 */
export async function replaceLabelActions(
  oxyUserId: string,
  actions: readonly LabelAction[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const [row] = await db
    .select({ id: userSettings.id })
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, oxyUserId));
  if (!row) return;
  await db.delete(userSettingsLabelActions).where(eq(userSettingsLabelActions.settingsId, row.id));
  if (actions.length === 0) return;
  await db.insert(userSettingsLabelActions).values(
    actions.map((action) => ({ settingsId: row.id, ...action })),
  );
}

/** Several users' settings in one query — the hydration batch path. */
export async function loadUserSettingsByIds(
  oxyUserIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, UserSettingsRecord>> {
  if (oxyUserIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(userSettings)
    .where(inArray(userSettings.oxyUserId, [...oxyUserIds]));
  if (rows.length === 0) return new Map();
  const actions = await db
    .select({
      settingsId: userSettingsLabelActions.settingsId,
      labelerId: userSettingsLabelActions.labelerId,
      labelSlug: userSettingsLabelActions.labelSlug,
      action: userSettingsLabelActions.action,
    })
    .from(userSettingsLabelActions)
    .where(inArray(userSettingsLabelActions.settingsId, rows.map((row) => row.id)));

  const bySettingsId = new Map<string, LabelAction[]>();
  for (const entry of actions) {
    const list = bySettingsId.get(entry.settingsId);
    const action = { labelerId: entry.labelerId, labelSlug: entry.labelSlug, action: entry.action };
    if (list) list.push(action);
    else bySettingsId.set(entry.settingsId, [action]);
  }

  return new Map(
    rows.map((row) => [row.oxyUserId, assembleRecord(row, bySettingsId.get(row.id) ?? [])]),
  );
}
