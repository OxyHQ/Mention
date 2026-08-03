/**
 * Per-viewer state: `user_behaviors` (+ its three preference child tables) and
 * `user_settings` (+ its label-action child table).
 *
 * Both were single documents holding deeply nested objects and arrays of
 * subdocuments. `UserSettings` in particular nested eight settings groups five
 * levels deep; every leaf has a known type, so every leaf becomes a column. The
 * contract's `jsonb` escape hatch is for genuinely shape-less data and none of
 * this is that — a settings blob would make "which viewers opted into sensitive
 * content" unanswerable by an index, which is a predicate the safety gate runs.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';

/** `ThemeMode`. */
export const THEME_MODES = ['light', 'dark', 'system', 'adaptive'] as const;

/** `PostTextExpand`. */
export const POST_TEXT_EXPANDS = ['default', 'more', 'muchMore', 'all'] as const;

/** `PostReadMoreAction`. */
export const POST_READ_MORE_ACTIONS = ['openPost', 'expandInline'] as const;

/** `PrivacySettings.profileVisibility`. */
export const PROFILE_VISIBILITIES = ['public', 'private', 'followers_only'] as const;

/** `LabelAction.action`. */
export const LABEL_PREFERENCE_ACTIONS = ['hide', 'warn', 'blur', 'show'] as const;

/** `ProfileMedia.type` — a pinned song OR a pinned podcast show, never both. */
export const PROFILE_MEDIA_TYPES = ['song', 'podcast'] as const;

/** An external-embed preference is a tri-state; absent means "ask on first play". */
export const EXTERNAL_EMBED_PREFERENCES = ['show', 'hide'] as const;

/**
 * The only legal values of `user_behaviors.active_hours` — hours of the day.
 *
 * Spelled out as a set because the CHECK below tests array CONTAINMENT: a CHECK
 * constraint may not contain a subquery, so `unnest(...)` is unavailable and
 * "every element is between 0 and 23" has to be written as "the array is a
 * subset of these 24 values".
 */
const ACTIVE_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** A tri-state external-embed column: `'show'`, `'hide'`, or absent. */
const embedPreference = () => text({ enum: EXTERNAL_EMBED_PREFERENCES });

/**
 * `user_behaviors` — learned interaction patterns for feed personalization.
 *
 * The four negative-signal arrays (`hiddenAuthors`, `mutedAuthors`,
 * `blockedAuthors`, `hiddenTopics`) stay `text[]`: they are read WHOLE into the
 * ranking context on every For You request and never joined, so a junction would
 * turn one row read into four. `preferredAuthors` / `preferredTopics` /
 * `preferredRegions` are different — they are arrays of SUBDOCUMENTS with
 * counters that are incremented individually, which is a child table.
 */
export const userBehaviors = pgTable(
  'user_behaviors',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per user. */
    oxyUserId: text().notNull().unique('user_behaviors_oxy_user_id_key'),

    // Post-type affinity — four fixed buckets, so four columns.
    preferredPostTypeText: integer().notNull().default(0),
    preferredPostTypeImage: integer().notNull().default(0),
    preferredPostTypeVideo: integer().notNull().default(0),
    preferredPostTypePoll: integer().notNull().default(0),

    /** Hours 0..23 the user is most active. A small scalar set. */
    activeHours: integer().array(),
    preferredLanguages: text().array(),

    averageEngagementTime: doublePrecision().notNull().default(0),
    skipRate: doublePrecision().notNull().default(0),
    completionRate: doublePrecision().notNull().default(0),

    /** Negative signals — Oxy account ids / topic slugs. Read whole. */
    hiddenAuthors: text().array(),
    mutedAuthors: text().array(),
    blockedAuthors: text().array(),
    hiddenTopics: text().array(),

    lastUpdated: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'user_behaviors_rates_check',
      sql`${t.skipRate} between 0 and 1 and ${t.completionRate} between 0 and 1`
    ),
    // Array CONTAINMENT rather than a per-element predicate: a CHECK constraint
    // cannot hold a subquery (`cannot use subquery in check constraint`), so the
    // legal set is spelled out and `<@` asserts every element is in it. Same
    // shape as `posts.reply_permission`.
    check(
      'user_behaviors_active_hours_check',
      sql`${t.activeHours} <@ ${sql.raw(`array[${ACTIVE_HOURS.join(', ')}]::integer[]`)}`
    ),
  ]
);

/** `user_behavior_authors` — per-author affinity with its interaction breakdown. */
export const userBehaviorAuthors = pgTable(
  'user_behavior_authors',
  {
    id: generatedId(),
    behaviorId: text()
      .notNull()
      .references(() => userBehaviors.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    authorId: text().notNull(),
    interactionCount: integer().notNull().default(0),
    lastInteractionAt: timestamptz().notNull().defaultNow(),
    likes: integer().notNull().default(0),
    boosts: integer().notNull().default(0),
    comments: integer().notNull().default(0),
    saves: integer().notNull().default(0),
    shares: integer().notNull().default(0),
    /** Calculated relationship strength, 0..1. */
    weight: doublePrecision().notNull().default(0),
  },
  (t) => [
    check('user_behavior_authors_weight_check', sql`${t.weight} between 0 and 1`),
    unique('user_behavior_authors_behavior_id_author_id_key').on(t.behaviorId, t.authorId),
    // Mongo indexed `preferredAuthors.authorId` — the reverse lookup.
    index('user_behavior_authors_author_id_idx').on(t.authorId),
  ]
);

/** `user_behavior_topics` — per-topic affinity. */
export const userBehaviorTopics = pgTable(
  'user_behavior_topics',
  {
    id: generatedId(),
    behaviorId: text()
      .notNull()
      .references(() => userBehaviors.id, { onDelete: 'cascade' }),
    /** The canonical topic slug. */
    topic: text().notNull(),
    /** An Oxy Topic-registry id — no foreign key. */
    topicId: text(),
    interactionCount: integer().notNull().default(0),
    lastInteractionAt: timestamptz().notNull().defaultNow(),
    weight: doublePrecision().notNull().default(0),
  },
  (t) => [
    check('user_behavior_topics_weight_check', sql`${t.weight} between 0 and 1`),
    unique('user_behavior_topics_behavior_id_topic_key').on(t.behaviorId, t.topic),
  ]
);

/**
 * `user_behavior_regions` — a counted multiset of region affinities.
 *
 * Stored as counts rather than a single mutable field so the dominant region is
 * stable across interactions instead of thrashing on every engagement.
 */
export const userBehaviorRegions = pgTable(
  'user_behavior_regions',
  {
    id: generatedId(),
    behaviorId: text()
      .notNull()
      .references(() => userBehaviors.id, { onDelete: 'cascade' }),
    /** A coarse region/country code (`US`, `DE`). */
    region: text().notNull(),
    count: doublePrecision().notNull().default(0),
    lastInteractionAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check('user_behavior_regions_count_check', sql`${t.count} >= 0`),
    unique('user_behavior_regions_behavior_id_region_key').on(t.behaviorId, t.region),
  ]
);

/**
 * `user_settings` — every Mention-owned per-user preference.
 *
 * Mention-owned only: identity (display name, avatar, bio) is Oxy's, and the
 * fediverse-sharing consent flag lives in Oxy's `privacySettings` and is
 * deliberately never stored here.
 *
 * The `feedTuning` group carries no bounds in the schema on purpose, exactly as
 * in Mongo: `validateForYouTuning` (the shared spec) is the authoritative
 * validator run in the settings controller before any write, so duplicating its
 * ranges as CHECKs would create a second place for them to drift.
 */
export const userSettings = pgTable(
  'user_settings',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per user. */
    oxyUserId: text().notNull().unique('user_settings_oxy_user_id_key'),

    // ── appearance ──
    appearanceThemeMode: text({ enum: THEME_MODES }).notNull().default('system'),
    appearancePrimaryColor: text(),
    appearancePostTextExpand: text({ enum: POST_TEXT_EXPANDS }).notNull().default('default'),
    appearancePostReadMoreAction: text({ enum: POST_READ_MORE_ACTIONS })
      .notNull()
      .default('openPost'),
    appearanceCollapseLongBio: boolean().notNull().default(true),

    /** An Oxy file id for the profile banner. Mention-owned; emitted as AP `image`. */
    profileHeaderImage: text(),

    // ── privacy ──
    privacyProfileVisibility: text({ enum: PROFILE_VISIBILITIES }).notNull().default('public'),
    privacyShowContactInfo: boolean().notNull().default(true),
    privacyAllowTags: boolean().notNull().default(true),
    privacyAllowMentions: boolean().notNull().default(true),
    privacyShowOnlineStatus: boolean().notNull().default(true),
    privacyHideLikeCounts: boolean().notNull().default(false),
    privacyHideShareCounts: boolean().notNull().default(false),
    privacyHideReplyCounts: boolean().notNull().default(false),
    privacyHideSaveCounts: boolean().notNull().default(false),
    /** Opt-IN to sensitive/NSFW content in discovery. Default false. */
    privacyShowSensitiveContent: boolean().notNull().default(false),
    privacyHiddenWords: text().array(),
    /** Oxy account ids who see limited content. Read whole — no junction. */
    privacyRestrictedUsers: text().array(),
    /** `labelers.id` values the viewer subscribes to. Read whole. */
    privacySubscribedLabelers: text().array(),

    /**
     * Whether a post published by this account, WHEN THIS ACCOUNT IS A CHANNEL,
     * also names the person who wrote it.
     *
     * **NULLABLE, and the null is the point.** Mongo held this in a
     * `channelAccount` subdocument that is ABSENT on a person's settings, which
     * is what makes "is this account a channel" a question nothing here has to
     * answer. Flattened to `NOT NULL DEFAULT false` that distinction would be
     * destroyed — every person's settings would read as a channel that does not
     * sign, and the two states are then indistinguishable at every call site.
     * So: NULL = not a channel account, false = a channel that does not sign,
     * true = one that does.
     *
     * `false` is the default for a channel that HAS the setting, matching
     * `channels.sign_posts` — a channel post is anonymous behind the channel
     * unless its owner says otherwise. Getting that backwards would publish
     * every writer's identity by omission.
     */
    channelAccountSignPosts: boolean(),

    // ── profileCustomization ──
    profileCoverPhotoEnabled: boolean().notNull().default(true),
    profileMinimalistMode: boolean().notNull().default(false),
    /**
     * The single pinned profile media. Mongo held a discriminated union in one
     * subdocument so that storing one shape REPLACED the other; flattened, that
     * mutual exclusion becomes the CHECK below rather than an emergent property
     * of overwriting a field.
     */
    profileMediaType: text({ enum: PROFILE_MEDIA_TYPES }),
    profileMediaTitle: text(),
    profileMediaArtworkUrl: text(),
    profileMediaSyraTrackId: text(),
    profileMediaArtist: text(),
    profileMediaPreviewUrl: text(),
    profileMediaStartSec: doublePrecision(),
    profileMediaDurationSec: doublePrecision(),
    profileMediaSyraPodcastId: text(),
    profileMediaAuthor: text(),
    profileMediaShowUrl: text(),

    /** Interest tags the user picked during onboarding. */
    interestTags: text().array(),

    // ── feedSettings ──
    feedDiversityEnabled: boolean().notNull().default(true),
    feedSameAuthorPenalty: doublePrecision().notNull().default(0.95),
    feedSameTopicPenalty: doublePrecision().notNull().default(0.92),
    feedMaxConsecutiveSameAuthor: integer(),
    feedRecencyHalfLifeHours: doublePrecision().notNull().default(24),
    feedRecencyMaxAgeHours: doublePrecision().notNull().default(168),
    feedMinEngagementRate: doublePrecision(),
    feedBoostHighQuality: boolean().notNull().default(true),

    // ── feedTuning.forYou (bounds owned by `validateForYouTuning`) ──
    tuningMinLengthEnabled: boolean(),
    tuningMinLength: integer(),
    tuningLowEffortGateEnabled: boolean(),
    tuningMinMeaningfulTextLength: integer(),
    tuningNativeEngagementEnabled: boolean(),
    tuningMinNativeEngagement: doublePrecision(),
    tuningMinQualityEnabled: boolean(),
    tuningMinQuality: doublePrecision(),

    // ── notificationPreferences ──
    notifyPushEnabled: boolean().notNull().default(true),
    notifyEmailEnabled: boolean().notNull().default(false),
    notifyLikes: boolean().notNull().default(true),
    notifyBoosts: boolean().notNull().default(true),
    notifyFollows: boolean().notNull().default(true),
    notifyMentions: boolean().notNull().default(true),
    notifyReplies: boolean().notNull().default(true),
    notifyQuotes: boolean().notNull().default(true),

    // ── externalEmbeds (per provider, tri-state) ──
    embedYoutube: embedPreference(),
    embedYoutubeShorts: embedPreference(),
    embedVimeo: embedPreference(),
    embedTwitch: embedPreference(),
    embedGiphy: embedPreference(),
    embedSpotify: embedPreference(),
    embedAppleMusic: embedPreference(),
    embedSoundcloud: embedPreference(),
    embedFlickr: embedPreference(),
    embedBandcamp: embedPreference(),

    /**
     * The user's default primary post language, canonical BCP-47. Mention-owned
     * (NOT an Oxy identity field): it seeds the composer's default variant.
     */
    fediversePreferredLanguage: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'user_settings_theme_mode_check',
      sql`${t.appearanceThemeMode} in (${sql.raw(inList(THEME_MODES))})`
    ),
    check(
      'user_settings_post_text_expand_check',
      sql`${t.appearancePostTextExpand} in (${sql.raw(inList(POST_TEXT_EXPANDS))})`
    ),
    check(
      'user_settings_post_read_more_action_check',
      sql`${t.appearancePostReadMoreAction} in (${sql.raw(inList(POST_READ_MORE_ACTIONS))})`
    ),
    check(
      'user_settings_profile_visibility_check',
      sql`${t.privacyProfileVisibility} in (${sql.raw(inList(PROFILE_VISIBILITIES))})`
    ),
    check(
      'user_settings_profile_media_type_check',
      sql`${t.profileMediaType} is null or ${t.profileMediaType} in (${sql.raw(inList(PROFILE_MEDIA_TYPES))})`
    ),
    // The mutual exclusion Mongo got from storing one subdocument: a song's
    // fields cannot coexist with a podcast's, and neither can exist untyped.
    check(
      'user_settings_profile_media_shape_check',
      sql`(${t.profileMediaType} is null
          and ${t.profileMediaSyraTrackId} is null
          and ${t.profileMediaSyraPodcastId} is null)
        or (${t.profileMediaType} = 'song'
          and ${t.profileMediaSyraTrackId} is not null
          and ${t.profileMediaPreviewUrl} is not null
          and ${t.profileMediaSyraPodcastId} is null)
        or (${t.profileMediaType} = 'podcast'
          and ${t.profileMediaSyraPodcastId} is not null
          and ${t.profileMediaShowUrl} is not null
          and ${t.profileMediaSyraTrackId} is null)`
    ),
    check(
      'user_settings_feed_penalties_check',
      sql`${t.feedSameAuthorPenalty} between 0.5 and 1.0
        and ${t.feedSameTopicPenalty} between 0.5 and 1.0`
    ),
    check(
      'user_settings_feed_recency_check',
      sql`${t.feedRecencyHalfLifeHours} between 6 and 72
        and ${t.feedRecencyMaxAgeHours} between 24 and 336`
    ),
    check(
      'user_settings_feed_min_engagement_check',
      sql`${t.feedMinEngagementRate} is null or ${t.feedMinEngagementRate} between 0 and 1`
    ),
    check(
      'user_settings_max_consecutive_same_author_check',
      sql`${t.feedMaxConsecutiveSameAuthor} is null
        or ${t.feedMaxConsecutiveSameAuthor} between 1 and 10`
    ),
    check(
      'user_settings_external_embeds_check',
      sql`(${t.embedYoutube} is null or ${t.embedYoutube} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedYoutubeShorts} is null or ${t.embedYoutubeShorts} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedVimeo} is null or ${t.embedVimeo} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedTwitch} is null or ${t.embedTwitch} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedGiphy} is null or ${t.embedGiphy} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedSpotify} is null or ${t.embedSpotify} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedAppleMusic} is null or ${t.embedAppleMusic} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedSoundcloud} is null or ${t.embedSoundcloud} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedFlickr} is null or ${t.embedFlickr} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))
        and (${t.embedBandcamp} is null or ${t.embedBandcamp} in (${sql.raw(inList(EXTERNAL_EMBED_PREFERENCES))}))`
    ),
  ]
);

/**
 * `user_settings_label_actions` — the viewer's per-label override of a labeler's
 * `defaultAction`.
 *
 * `labeler_id` carries no foreign key deliberately: the subscription is stored
 * as a raw id string today and `LabelService.getUserEffectiveLabels` already
 * tolerates a labeler that no longer resolves. A constraint would turn a
 * deleted labeler into a failed settings WRITE instead of an ignored preference.
 */
export const userSettingsLabelActions = pgTable(
  'user_settings_label_actions',
  {
    id: generatedId(),
    settingsId: text()
      .notNull()
      .references(() => userSettings.id, { onDelete: 'cascade' }),
    /** A `labelers.id`. Deliberately unconstrained — see the docblock. */
    labelerId: text().notNull(),
    labelSlug: text().notNull(),
    action: text({ enum: LABEL_PREFERENCE_ACTIONS }).notNull(),
  },
  (t) => [
    check(
      'user_settings_label_actions_action_check',
      sql`${t.action} in (${sql.raw(inList(LABEL_PREFERENCE_ACTIONS))})`
    ),
    unique('user_settings_label_actions_settings_labeler_slug_key').on(
      t.settingsId,
      t.labelerId,
      t.labelSlug
    ),
  ]
);
