/**
 * Per-viewer state: `userbehaviors` (+ its three preference child tables) and
 * `usersettings` (+ its label-action child table).
 *
 * Both were single documents holding deeply nested objects, and `UserSettings`
 * nested eight settings groups five levels deep. Every leaf has a known type, so
 * every leaf is a column — a settings blob would make "which viewers opted into
 * sensitive content" unanswerable by an index, and that is a predicate the
 * safety gate runs. The transform is therefore long and boring on purpose; the
 * four interesting parts are below.
 *
 * ## The two array shapes in `userbehaviors` are NOT the same problem
 *
 * `hiddenAuthors` / `mutedAuthors` / `blockedAuthors` / `hiddenTopics` stay
 * `text[]`: they are read WHOLE into the ranking context on every For You
 * request and never joined, so a junction would turn one row read into four.
 * `preferredAuthors` / `preferredTopics` / `preferredRegions` are arrays of
 * SUBDOCUMENTS with counters incremented individually — child tables. Copying
 * the first group as junctions would be as wrong as copying the second as
 * arrays.
 *
 * ## The CHECKs Mongoose declared and never enforced
 *
 * `runValidators` is set nowhere in this package, so every `min`/`max` in these
 * two models is decoration: `skipRate`, `completionRate` and both `weight`
 * fields are declared `0..1` in Mongo and can hold anything. Each has a real
 * CHECK here and therefore a numeric audit. `activeHours` is the same shape one
 * level down — the CHECK is array CONTAINMENT (`<@ array[0..23]`) because a
 * CHECK cannot hold a subquery, and Mongo's `distinct` on an array field returns
 * the ELEMENTS, so an ordinary bounded audit lines up with it exactly.
 *
 * ## `profile_media` is a discriminated union Mongo enforced by OVERWRITING
 *
 * Mongo held one subdocument, so storing a song replaced any podcast — the
 * mutual exclusion was an emergent property of there being one field.
 * Flattened into eleven columns it becomes
 * `user_settings_profile_media_shape_check`, and that CHECK is STRICTER than the
 * subschema was: it requires a song to carry `preview_url` and a podcast to
 * carry `show_url`, both of which `ProfileMediaSchema` declares optional. A
 * half-written media item is therefore storable in Mongo and rejected here, so
 * the transform refuses one by name rather than letting the copy die on a
 * `23514` partway through. Dropping the media instead would silently unpin a
 * profile song the user chose, and inventing a `previewUrl` would fabricate a
 * URL the client would try to play.
 *
 * ## `feedTuning` deliberately has NO bounds, and `feedSettings` does
 *
 * The two look alike and are governed differently. `validateForYouTuning` (the
 * shared spec) is the authoritative validator for `feedTuning`, run in the
 * settings controller before any write, so the schema carries no CHECK for it
 * and there is nothing here to audit — duplicating those ranges would create a
 * second place for them to drift. `feedSettings` DOES carry CHECKs, so its five
 * bounded fields are audited.
 */

import {
  userBehaviorAuthors,
  userBehaviorRegions,
  userBehaviorTopics,
  userBehaviors,
  userSettings,
  userSettingsLabelActions,
} from '../../schema/userProfile';
import type { CollectionPlan, Emit, EnumAudit } from '../plan';
import { buildRow } from '../rowBuilder';
import {
  bool,
  childRowId,
  id,
  int,
  num,
  ownId,
  reqStr,
  str,
  strArray,
  numArray,
  subdocuments,
  type MongoDocument,
} from '../values';
import { optionalDate, timestamps } from './timestamps';

/**
 * The ten external-embed providers: Mongo path, Postgres column, in ONE list.
 *
 * Two hand-written lists of ten would let a provider be audited but not copied,
 * or copied but not audited, and either mistake is invisible — the column just
 * stays NULL for everyone, which is also what "nobody set a preference" looks
 * like. Deriving both from this makes that shape impossible.
 */
const EMBED_PROVIDERS = [
  ['youtube', 'embedYoutube', userSettings.embedYoutube],
  ['youtubeShorts', 'embedYoutubeShorts', userSettings.embedYoutubeShorts],
  ['vimeo', 'embedVimeo', userSettings.embedVimeo],
  ['twitch', 'embedTwitch', userSettings.embedTwitch],
  ['giphy', 'embedGiphy', userSettings.embedGiphy],
  ['spotify', 'embedSpotify', userSettings.embedSpotify],
  ['appleMusic', 'embedAppleMusic', userSettings.embedAppleMusic],
  ['soundcloud', 'embedSoundcloud', userSettings.embedSoundcloud],
  ['flickr', 'embedFlickr', userSettings.embedFlickr],
  ['bandcamp', 'embedBandcamp', userSettings.embedBandcamp],
] as const;

/** `userbehaviors` → `user_behaviors` + three preference child tables. */
const userBehaviorsPlan: CollectionPlan = {
  collection: 'userbehaviors',
  table: userBehaviors,
  childTables: [userBehaviorAuthors, userBehaviorTopics, userBehaviorRegions],
  numericAudits: [
    {
      path: 'skipRate',
      column: userBehaviors.skipRate,
      constraint: 'user_behaviors_rates_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    {
      path: 'completionRate',
      column: userBehaviors.completionRate,
      constraint: 'user_behaviors_rates_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    {
      // An ARRAY path: `distinct` returns the ELEMENTS, which is exactly what
      // `<@ array[0..23]` constrains. The column is nullable, so the audit's
      // null branch already declines an absent array.
      path: 'activeHours',
      column: userBehaviors.activeHours,
      constraint: 'user_behaviors_active_hours_check',
      min: 0,
      max: 23,
    },
    // The three child-table bounds. Same array-path mechanism, one level deeper.
    {
      path: 'preferredAuthors.weight',
      column: userBehaviorAuthors.weight,
      constraint: 'user_behavior_authors_weight_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    {
      path: 'preferredTopics.weight',
      column: userBehaviorTopics.weight,
      constraint: 'user_behavior_topics_weight_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    {
      path: 'preferredRegions.count',
      column: userBehaviorRegions.count,
      constraint: 'user_behavior_regions_count_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    {
      // Mongo declared `unique: true` on this one, so a collision means the
      // index was missing or built after the duplicates — worth asking rather
      // than assuming, since a second behavior row for one viewer would make
      // which preferences apply depend on document order.
      index: 'user_behaviors_oxy_user_id_key',
      key: [{ path: 'oxyUserId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    const behaviorId = ownId(doc);

    emit(
      userBehaviors,
      buildRow(
        userBehaviors,
        {
          id: behaviorId,
          oxyUserId: reqStr(doc, 'oxyUserId'),

          // Four FIXED buckets, so four columns rather than a junction — the set
          // is closed by the post model, not by data.
          preferredPostTypeText: num(doc, 'preferredPostTypes.text') ?? 0,
          preferredPostTypeImage: num(doc, 'preferredPostTypes.image') ?? 0,
          preferredPostTypeVideo: num(doc, 'preferredPostTypes.video') ?? 0,
          preferredPostTypePoll: num(doc, 'preferredPostTypes.poll') ?? 0,

          activeHours: numArray(doc, 'activeHours'),
          preferredLanguages: strArray(doc, 'preferredLanguages'),

          averageEngagementTime: num(doc, 'averageEngagementTime') ?? 0,
          skipRate: num(doc, 'skipRate') ?? 0,
          completionRate: num(doc, 'completionRate') ?? 0,

          // Read WHOLE on every For You request — see the module docblock for
          // why these four stay arrays while the three below become tables.
          hiddenAuthors: strArray(doc, 'hiddenAuthors'),
          mutedAuthors: strArray(doc, 'mutedAuthors'),
          blockedAuthors: strArray(doc, 'blockedAuthors'),
          hiddenTopics: strArray(doc, 'hiddenTopics'),

          ...optionalDate(doc, 'lastUpdated', 'lastUpdated'),
          ...timestamps(doc),
        },
        behaviorId
      )
    );

    emitAuthorPreferences(doc, behaviorId, emit);
    emitTopicPreferences(doc, behaviorId, emit);
    emitRegionPreferences(doc, behaviorId, emit);
  },
};

/**
 * `preferredAuthors[]` → `user_behavior_authors`, deduped on the AUTHOR.
 *
 * These three junctions have NO `position` column — the arrays are counted
 * multisets keyed by their subject, and nothing reads their order. So the dedup
 * has only one failure mode to avoid (a duplicate violating the unique key and
 * being swallowed by `ON CONFLICT DO NOTHING`), not the two the ordered member
 * junctions have. FIRST occurrence wins: a later duplicate is a duplicate, not a
 * correction, and picking the larger counter would be this migration inventing
 * an aggregate nothing wrote.
 */
function emitAuthorPreferences(doc: MongoDocument, behaviorId: string, emit: Emit): void {
  const seen = new Set<string>();
  for (const [preference, ordinal] of subdocuments(doc, 'preferredAuthors')) {
    const authorId = reqStr(preference, 'authorId');
    if (seen.has(authorId)) continue;
    seen.add(authorId);
    emit(
      userBehaviorAuthors,
      buildRow(
        userBehaviorAuthors,
        {
          // `{ _id: false }` on the subschema, so this id is DERIVED from the
          // source ORDINAL — a pure function of the document, which is what lets
          // a re-run conflict with the row it already wrote.
          id: childRowId(preference, behaviorId, 'preferredAuthors', ordinal),
          behaviorId,
          authorId,
          // `num`, not `int`: an accumulated engagement WEIGHT, exactly like
          // `preferredRegions.count` below. `UserPreferenceService` adds the
          // fractional learning weights (`view` 0.2, `save` 1.5) to it, so
          // essentially every production row holds a non-integer here and `int`
          // — which `fail`s rather than truncating — would abort the copy.
          interactionCount: num(preference, 'interactionCount') ?? 0,
          // Mongo nests the five counters under `interactionTypes`; Postgres
          // flattens them, because each is a plain integer with a known name.
          likes: int(preference, 'interactionTypes.likes') ?? 0,
          boosts: int(preference, 'interactionTypes.boosts') ?? 0,
          comments: int(preference, 'interactionTypes.comments') ?? 0,
          saves: int(preference, 'interactionTypes.saves') ?? 0,
          shares: int(preference, 'interactionTypes.shares') ?? 0,
          weight: num(preference, 'weight') ?? 0,
          ...optionalDate(preference, 'lastInteractionAt', 'lastInteractionAt'),
        },
        behaviorId
      )
    );
  }
}

/** `preferredTopics[]` → `user_behavior_topics`, deduped on the TOPIC SLUG. */
function emitTopicPreferences(doc: MongoDocument, behaviorId: string, emit: Emit): void {
  const seen = new Set<string>();
  for (const [preference, ordinal] of subdocuments(doc, 'preferredTopics')) {
    const topic = reqStr(preference, 'topic');
    if (seen.has(topic)) continue;
    seen.add(topic);
    emit(
      userBehaviorTopics,
      buildRow(
        userBehaviorTopics,
        {
          id: childRowId(preference, behaviorId, 'preferredTopics', ordinal),
          behaviorId,
          // The unique key is `(behavior, topic)` — the SLUG, not `topicId`.
          // That is deliberate in the schema: the slug is what the ranking reads,
          // and `topicId` is an optional pointer into Oxy's Topic registry that
          // an older preference simply does not have.
          topic,
          // A real `ObjectId` in Mongo (`ref: 'Topic'`) but no foreign key here —
          // the registry is Oxy's, so `id` rather than `reqId`, and NULL when the
          // preference was learned before the registry existed.
          topicId: id(preference, 'topicId'),
          // A weight, not a tally — see `emitAuthorPreferences`.
          interactionCount: num(preference, 'interactionCount') ?? 0,
          weight: num(preference, 'weight') ?? 0,
          ...optionalDate(preference, 'lastInteractionAt', 'lastInteractionAt'),
        },
        behaviorId
      )
    );
  }
}

/** `preferredRegions[]` → `user_behavior_regions`, deduped on the REGION. */
function emitRegionPreferences(doc: MongoDocument, behaviorId: string, emit: Emit): void {
  const seen = new Set<string>();
  for (const [preference, ordinal] of subdocuments(doc, 'preferredRegions')) {
    const region = reqStr(preference, 'region');
    if (seen.has(region)) continue;
    seen.add(region);
    emit(
      userBehaviorRegions,
      buildRow(
        userBehaviorRegions,
        {
          id: childRowId(preference, behaviorId, 'preferredRegions', ordinal),
          behaviorId,
          region,
          // `count` is an accumulated engagement WEIGHT, not a tally, so it is
          // `double precision` here and `num` rather than `int` — reading it as
          // an integer would silently truncate a fractional accumulation.
          count: num(preference, 'count') ?? 0,
          ...optionalDate(preference, 'lastInteractionAt', 'lastInteractionAt'),
        },
        behaviorId
      )
    );
  }
}

/** Every enum-backed settings field, including the ten embed providers. */
const settingsEnumAudits: readonly EnumAudit[] = [
  { path: 'appearance.themeMode', column: userSettings.appearanceThemeMode, absentAs: 'system' },
  {
    path: 'appearance.postTextExpand',
    column: userSettings.appearancePostTextExpand,
    absentAs: 'default',
  },
  {
    path: 'appearance.postReadMoreAction',
    column: userSettings.appearancePostReadMoreAction,
    absentAs: 'openPost',
  },
  {
    path: 'privacy.profileVisibility',
    column: userSettings.privacyProfileVisibility,
    absentAs: 'public',
  },
  // NULLABLE, so the audit's null branch declines an unpinned profile.
  {
    path: 'profileCustomization.profileMedia.type',
    column: userSettings.profileMediaType,
  },
  // A path into an array of subdocuments — `distinct` returns the elements'
  // values, which is the set the CHILD table's CHECK constrains.
  {
    path: 'privacy.labelPreferences.labelActions.action',
    column: userSettingsLabelActions.action,
  },
  ...EMBED_PROVIDERS.map(([provider, , column]) => ({
    path: `externalEmbeds.${provider}`,
    column,
  })),
];

/** `usersettings` → `user_settings` + `user_settings_label_actions`. */
const userSettingsPlan: CollectionPlan = {
  collection: 'usersettings',
  table: userSettings,
  childTables: [userSettingsLabelActions],
  enumAudits: settingsEnumAudits,
  numericAudits: [
    {
      path: 'feedSettings.diversity.sameAuthorPenalty',
      column: userSettings.feedSameAuthorPenalty,
      constraint: 'user_settings_feed_penalties_check',
      min: 0.5,
      max: 1.0,
      absentAs: 0.95,
    },
    {
      path: 'feedSettings.diversity.sameTopicPenalty',
      column: userSettings.feedSameTopicPenalty,
      constraint: 'user_settings_feed_penalties_check',
      min: 0.5,
      max: 1.0,
      absentAs: 0.92,
    },
    {
      path: 'feedSettings.diversity.maxConsecutiveSameAuthor',
      column: userSettings.feedMaxConsecutiveSameAuthor,
      constraint: 'user_settings_max_consecutive_same_author_check',
      min: 1,
      max: 10,
    },
    {
      path: 'feedSettings.recency.halfLifeHours',
      column: userSettings.feedRecencyHalfLifeHours,
      constraint: 'user_settings_feed_recency_check',
      min: 6,
      max: 72,
      absentAs: 24,
    },
    {
      path: 'feedSettings.recency.maxAgeHours',
      column: userSettings.feedRecencyMaxAgeHours,
      constraint: 'user_settings_feed_recency_check',
      min: 24,
      max: 336,
      absentAs: 168,
    },
    {
      path: 'feedSettings.quality.minEngagementRate',
      column: userSettings.feedMinEngagementRate,
      constraint: 'user_settings_feed_min_engagement_check',
      min: 0,
      max: 1,
    },
    // `feedTuning.*` is NOT audited, and that is the schema's decision rather
    // than an omission — see the module docblock. Its bounds live in
    // `validateForYouTuning` and the columns carry no CHECK at all, so an audit
    // here would predict a constraint that does not exist.
  ],
  uniquenessAudits: [
    {
      index: 'user_settings_oxy_user_id_key',
      key: [{ path: 'oxyUserId', normalize: 'exact' }],
    },
  ],
  // One column here was reading a path NO document has, and sixteen more fill a
  // gap with a constant. Both facts are measurements rather than readings of
  // the code: only counting the source side separates "the mapping is wrong"
  // from "the users never set this", and from here the two look identical.
  //
  // Every fallback below was compared against the DELETED Mongoose schema,
  // recovered from `8b783a8d^`, and every one matches its declared `default:`
  // exactly. So a document without the field already read as this value
  // throughout the application and copying it is the port; NULL would be the
  // behaviour change. The counts are what make that a claim about the data
  // rather than about the code — `notificationPreferences.pushEnabled` is
  // carried by ZERO of 39,349 documents and `feedSettings.diversity.enabled` by
  // ONE, which is what a preference nobody ever opened looks like.
  columnCoverage: [
    {
      table: userSettings,
      column: userSettings.channelAccountSignPosts,
      sourcePath: 'channel.signPosts',
    },
    ...(
      [
        ['appearancePostTextExpand', 'appearance.postTextExpand', 39_340, "'default'"],
        ['appearancePostReadMoreAction', 'appearance.postReadMoreAction', 22_105, "'openPost'"],
        ['appearanceCollapseLongBio', 'appearance.collapseLongBio', 22_105, 'true'],
        ['privacyShowSensitiveContent', 'privacy.showSensitiveContent', 39_339, 'false'],
        ['profileCoverPhotoEnabled', 'profileCustomization.coverPhotoEnabled', 22, 'true'],
        ['profileMinimalistMode', 'profileCustomization.minimalistMode', 22, 'false'],
        ['feedDiversityEnabled', 'feedSettings.diversity.enabled', 1, 'true'],
        ['feedSameAuthorPenalty', 'feedSettings.diversity.sameAuthorPenalty', 1, '0.95'],
        ['feedSameTopicPenalty', 'feedSettings.diversity.sameTopicPenalty', 1, '0.92'],
        ['feedRecencyHalfLifeHours', 'feedSettings.recency.halfLifeHours', 1, '24'],
        ['feedRecencyMaxAgeHours', 'feedSettings.recency.maxAgeHours', 1, '168'],
        ['feedBoostHighQuality', 'feedSettings.quality.boostHighQuality', 1, 'true'],
        ['notifyPushEnabled', 'notificationPreferences.pushEnabled', 0, 'true'],
        ['notifyEmailEnabled', 'notificationPreferences.emailEnabled', 0, 'false'],
        ['notifyLikes', 'notificationPreferences.likes', 1, 'true'],
        ['notifyBoosts', 'notificationPreferences.boosts', 0, 'true'],
        ['notifyFollows', 'notificationPreferences.follows', 1, 'true'],
        ['notifyMentions', 'notificationPreferences.mentions', 0, 'true'],
        ['notifyReplies', 'notificationPreferences.replies', 0, 'true'],
        ['notifyQuotes', 'notificationPreferences.quotes', 0, 'true'],
      ] as const
    ).map(([property, sourcePath, present, value]) => ({
      table: userSettings,
      column: userSettings[property],
      sourcePath,
      filledWhenAbsent:
        `${present.toLocaleString('en-US')} of 39,349 documents carry ` +
        `\`${sourcePath}\`, and the deleted schema declares \`default: ${value}\`. ` +
        'The column is NOT NULL, so it holds something either way; this is the ' +
        'value the SOURCE names for an absent field.',
    })),
  ],
  transform: (doc, emit) => {
    const settingsId = ownId(doc);

    emit(
      userSettings,
      buildRow(
        userSettings,
        {
          id: settingsId,
          oxyUserId: reqStr(doc, 'oxyUserId'),

          appearanceThemeMode: str(doc, 'appearance.themeMode') ?? 'system',
          appearancePrimaryColor: str(doc, 'appearance.primaryColor'),
          appearancePostTextExpand: str(doc, 'appearance.postTextExpand') ?? 'default',
          appearancePostReadMoreAction: str(doc, 'appearance.postReadMoreAction') ?? 'openPost',
          appearanceCollapseLongBio: bool(doc, 'appearance.collapseLongBio') ?? true,

          profileHeaderImage: str(doc, 'profileHeaderImage'),

          privacyProfileVisibility: str(doc, 'privacy.profileVisibility') ?? 'public',
          privacyShowContactInfo: bool(doc, 'privacy.showContactInfo') ?? true,
          privacyAllowTags: bool(doc, 'privacy.allowTags') ?? true,
          privacyAllowMentions: bool(doc, 'privacy.allowMentions') ?? true,
          privacyShowOnlineStatus: bool(doc, 'privacy.showOnlineStatus') ?? true,
          privacyHideLikeCounts: bool(doc, 'privacy.hideLikeCounts') ?? false,
          privacyHideShareCounts: bool(doc, 'privacy.hideShareCounts') ?? false,
          privacyHideReplyCounts: bool(doc, 'privacy.hideReplyCounts') ?? false,
          privacyHideSaveCounts: bool(doc, 'privacy.hideSaveCounts') ?? false,
          // Opt-IN, and the default is the SAFE one. Reading an absent field as
          // `true` here would silently opt every legacy viewer into sensitive
          // content — the one default in this file where being wrong shows
          // content to someone who never asked for it.
          privacyShowSensitiveContent: bool(doc, 'privacy.showSensitiveContent') ?? false,
          privacyHiddenWords: strArray(doc, 'privacy.hiddenWords'),
          privacyRestrictedUsers: strArray(doc, 'privacy.restrictedUsers'),
          privacySubscribedLabelers: strArray(doc, 'privacy.labelPreferences.subscribedLabelers'),

          profileCoverPhotoEnabled: bool(doc, 'profileCustomization.coverPhotoEnabled') ?? true,
          profileMinimalistMode: bool(doc, 'profileCustomization.minimalistMode') ?? false,
          ...profileMediaColumns(doc, settingsId),

          // NULL when the subdocument is absent, which is the whole point: its
          // absence is what says this account is not a channel. `bool()` returns
          // null for a missing path, so no `?? false` here — that would migrate
          // every person's settings as a channel that does not sign.
          //
          // The PATH is `channel`, not `channelAccount`, and that is a fact
          // about MONGO rather than about the column's name.
          //
          // `ChannelAccountSchema` is mounted at `channel:` in the deleted model
          // (recovered from `8b783a8d^`), and `channelAccount.signPosts` matches
          // ZERO of 39,349 documents. Reading only `channelAccount` — which is
          // what this line did, with the correct reasoning above it — dropped
          // every value the field holds. Only counting the SOURCE side finds a
          // mapping that looks right and reads a field nothing has.
          //
          // `channelAccount` is the DTO's spelling, registered in
          // `SETTINGS_COLUMN_BY_PATH` because that map translates API dot-paths
          // to COLUMNS. Nothing has ever written it to Mongo: the settings PUT
          // writes Postgres, and the Mongoose model that wrote `channel` is
          // deleted. So there is no second era of data to read and no reason to
          // read both — a defensive `??` here would be a compatibility shim for
          // a case that cannot occur. The divergence is declared once, in
          // `backfillSettingsPathCoverage`, where it is about the two NAMES.
          channelAccountSignPosts: bool(doc, 'channel.signPosts'),

          interestTags: strArray(doc, 'interests.tags'),

          feedDiversityEnabled: bool(doc, 'feedSettings.diversity.enabled') ?? true,
          feedSameAuthorPenalty: num(doc, 'feedSettings.diversity.sameAuthorPenalty') ?? 0.95,
          feedSameTopicPenalty: num(doc, 'feedSettings.diversity.sameTopicPenalty') ?? 0.92,
          feedMaxConsecutiveSameAuthor: int(
            doc,
            'feedSettings.diversity.maxConsecutiveSameAuthor'
          ),
          feedRecencyHalfLifeHours: num(doc, 'feedSettings.recency.halfLifeHours') ?? 24,
          feedRecencyMaxAgeHours: num(doc, 'feedSettings.recency.maxAgeHours') ?? 168,
          feedMinEngagementRate: num(doc, 'feedSettings.quality.minEngagementRate'),
          feedBoostHighQuality: bool(doc, 'feedSettings.quality.boostHighQuality') ?? true,

          // Every tuning column is NULLABLE and stays NULL when absent: NULL
          // means "this viewer never overrode the gate", which is a different
          // state from any value the shared spec would default to. Substituting
          // the spec's default here would freeze today's default into the row
          // and stop the viewer tracking a later change to it.
          tuningMinLengthEnabled: bool(doc, 'feedTuning.forYou.minLength.enabled'),
          tuningMinLength: int(doc, 'feedTuning.forYou.minLength.minLength'),
          tuningLowEffortGateEnabled: bool(doc, 'feedTuning.forYou.lowEffortGate.enabled'),
          tuningMinMeaningfulTextLength: int(
            doc,
            'feedTuning.forYou.lowEffortGate.minMeaningfulTextLength'
          ),
          tuningNativeEngagementEnabled: bool(doc, 'feedTuning.forYou.nativeEngagement.enabled'),
          tuningMinNativeEngagement: num(
            doc,
            'feedTuning.forYou.nativeEngagement.minNativeEngagement'
          ),
          tuningMinQualityEnabled: bool(doc, 'feedTuning.forYou.minQuality.enabled'),
          tuningMinQuality: num(doc, 'feedTuning.forYou.minQuality.minQuality'),

          notifyPushEnabled: bool(doc, 'notificationPreferences.pushEnabled') ?? true,
          notifyEmailEnabled: bool(doc, 'notificationPreferences.emailEnabled') ?? false,
          notifyLikes: bool(doc, 'notificationPreferences.likes') ?? true,
          notifyBoosts: bool(doc, 'notificationPreferences.boosts') ?? true,
          notifyFollows: bool(doc, 'notificationPreferences.follows') ?? true,
          notifyMentions: bool(doc, 'notificationPreferences.mentions') ?? true,
          notifyReplies: bool(doc, 'notificationPreferences.replies') ?? true,
          notifyQuotes: bool(doc, 'notificationPreferences.quotes') ?? true,

          // TRI-STATE, all ten: absent means "ask on first play", which is
          // neither `show` nor `hide`. Defaulting any of them would answer a
          // consent question on the viewer's behalf.
          ...Object.fromEntries(
            EMBED_PROVIDERS.map(([provider, property]) => [
              property,
              str(doc, `externalEmbeds.${provider}`),
            ])
          ),

          fediversePreferredLanguage: str(doc, 'fediversePreferredLanguage'),
          ...timestamps(doc),
        },
        settingsId
      )
    );

    emitLabelActions(doc, settingsId, emit);
  },
};

/**
 * `privacy.labelPreferences.labelActions[]` → `user_settings_label_actions`.
 *
 * Deduped on `(labelerId, labelSlug)` — the unique key — because the embedded
 * array could hold the same pair twice and nothing in Mongo would notice.
 */
function emitLabelActions(doc: MongoDocument, settingsId: string, emit: Emit): void {
  const seen = new Set<string>();
  for (const [action, ordinal] of subdocuments(
    doc,
    'privacy.labelPreferences.labelActions'
  )) {
    const labelerId = reqStr(action, 'labelerId');
    const labelSlug = reqStr(action, 'labelSlug');
    // A composite map key. The separator is written as an ESCAPE rather than a
    // literal control character — a raw NUL in a source file is invisible in
    // every diff and every review.
    const key = `${labelerId}\u0000${labelSlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emit(
      userSettingsLabelActions,
      buildRow(
        userSettingsLabelActions,
        {
          id: childRowId(action, settingsId, 'labelActions', ordinal),
          settingsId,
          // Deliberately unconstrained: `LabelService.getUserEffectiveLabels`
          // already tolerates a labeler that no longer resolves, and a foreign
          // key would turn a deleted labeler into a failed settings WRITE
          // instead of an ignored preference.
          labelerId,
          labelSlug,
          action: reqStr(action, 'action'),
        },
        settingsId
      )
    );
  }
}

/**
 * The eleven flattened `profileMedia` columns — or eleven NULLs.
 *
 * @throws {Error} When the media cannot satisfy
 *   `user_settings_profile_media_shape_check`. See the module docblock: the
 *   CHECK is stricter than `ProfileMediaSchema` was, so a half-written item is
 *   storable in Mongo, and neither dropping it (silently unpinning a song the
 *   user chose) nor completing it (fabricating a URL a client would try to play)
 *   is an honest repair.
 */
function profileMediaColumns(doc: MongoDocument, settingsId: string): Record<string, unknown> {
  const type = str(doc, 'profileCustomization.profileMedia.type');
  const syraTrackId = str(doc, 'profileCustomization.profileMedia.syraTrackId');
  const previewUrl = str(doc, 'profileCustomization.profileMedia.previewUrl');
  const syraPodcastId = str(doc, 'profileCustomization.profileMedia.syraPodcastId');
  const showUrl = str(doc, 'profileCustomization.profileMedia.showUrl');

  const shapeIsLegal =
    (type === null && syraTrackId === null && syraPodcastId === null) ||
    (type === 'song' && syraTrackId !== null && previewUrl !== null && syraPodcastId === null) ||
    (type === 'podcast' && syraPodcastId !== null && showUrl !== null && syraTrackId === null);

  if (!shapeIsLegal) {
    throw new Error(
      `usersettings ${settingsId}: profileCustomization.profileMedia cannot satisfy ` +
        `user_settings_profile_media_shape_check (type=${type ?? 'absent'}, ` +
        `syraTrackId=${syraTrackId === null ? 'absent' : 'set'}, ` +
        `previewUrl=${previewUrl === null ? 'absent' : 'set'}, ` +
        `syraPodcastId=${syraPodcastId === null ? 'absent' : 'set'}, ` +
        `showUrl=${showUrl === null ? 'absent' : 'set'}). Mongo enforced the ` +
        'mutual exclusion by OVERWRITING one subdocument, so a half-written ' +
        'item is storable there and rejected here. Dropping it would unpin ' +
        'media the user chose; completing it would fabricate a URL a client ' +
        'would try to play. Count every instance with: ' +
        "db.usersettings.countDocuments({ 'profileCustomization.profileMedia': " +
        '{ $ne: null, $exists: true }, $nor: [ ' +
        "{ 'profileCustomization.profileMedia.type': 'song', " +
        "'profileCustomization.profileMedia.syraTrackId': { $exists: true }, " +
        "'profileCustomization.profileMedia.previewUrl': { $exists: true }, " +
        "'profileCustomization.profileMedia.syraPodcastId': { $exists: false } }, " +
        "{ 'profileCustomization.profileMedia.type': 'podcast', " +
        "'profileCustomization.profileMedia.syraPodcastId': { $exists: true }, " +
        "'profileCustomization.profileMedia.showUrl': { $exists: true }, " +
        "'profileCustomization.profileMedia.syraTrackId': { $exists: false } } ] })"
    );
  }

  return {
    profileMediaType: type,
    profileMediaTitle: str(doc, 'profileCustomization.profileMedia.title'),
    profileMediaArtworkUrl: str(doc, 'profileCustomization.profileMedia.artworkUrl'),
    profileMediaSyraTrackId: syraTrackId,
    profileMediaArtist: str(doc, 'profileCustomization.profileMedia.artist'),
    profileMediaPreviewUrl: previewUrl,
    profileMediaStartSec: num(doc, 'profileCustomization.profileMedia.startSec'),
    profileMediaDurationSec: num(doc, 'profileCustomization.profileMedia.durationSec'),
    profileMediaSyraPodcastId: syraPodcastId,
    profileMediaAuthor: str(doc, 'profileCustomization.profileMedia.author'),
    profileMediaShowUrl: showUrl,
  };
}

/** Both per-viewer plans. */
export const USER_PROFILE_PLANS: readonly CollectionPlan[] = [
  userBehaviorsPlan,
  userSettingsPlan,
];
