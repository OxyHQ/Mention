/**
 * `posts` → ten tables. The largest plan in the migration, and the one the rest
 * of the schema hangs off.
 *
 * `posts` itself, plus `post_authorships`, `post_content_variants`,
 * `post_variant_media`, `post_variant_alt_texts`, `post_media`,
 * `post_attachments`, `post_sources`, `post_mentions` and
 * `post_classification_topic_refs`. Mongo held every one of those as an array or
 * a map nested inside one document.
 *
 * ## The coordinate order is the single most dangerous thing in this file
 *
 * Mongo stores `location.coordinates` as GeoJSON: **`[longitude, latitude]`**,
 * longitude FIRST. The columns are named `latitude` and `longitude` separately,
 * so reading `coordinates[0]` into `latitude` compiles, inserts, and silently
 * moves every located post to a mirrored point on the globe. Nothing downstream
 * would notice: both values are numbers, both are in range for most of the
 * populated world, and the generated `geography` point would be built from the
 * swapped pair without complaint. `coordinates[1]` is the latitude. There are
 * TWO such pairs — `content.location` and the post-level `location` — and they
 * are both handled by one function so the order is written once.
 *
 * ## `is_reply` is DERIVED, because Mongo never had the field
 *
 * `utils/postReply.ts` computes it as a disjunction at every call site — a
 * native reply has `parentPostId`, a federated reply whose parent Mention never
 * imported has only `federation.inReplyTo`, and either test alone misclassifies
 * posts in both directions. The column is that disjunction, materialized. The
 * two CHECKs (`posts_reply_discriminator_check`,
 * `posts_federated_reply_discriminator_check`) make disagreement
 * unrepresentable, so this is not a convenience: computing it any other way
 * fails the insert.
 *
 * ## Four self-referencing columns, and the runner handles them
 *
 * `boostOf`, `quoteOf`, `parentPostId` and `threadId` all reference `posts.id`,
 * and Postgres checks each IMMEDIATELY — none of the constraints is
 * `DEFERRABLE`. The transform emits them normally; the runner's pass A writes
 * NULL and pass B re-streams and fills them once every row exists, with the
 * column set DERIVED from the foreign keys rather than listed (`order.ts`).
 *
 * The two-pass shape is not merely convenient, and `threadId` is what proves
 * it. A batch inserts rows in `_id` order, so it is tempting to imagine some
 * within-batch ordering that satisfies the references directly — sort the
 * parents first, insert roots before replies. That cannot work here: **a
 * thread's root is frequently NOT the lowest `_id` among its members** once
 * federated replies are interleaved, because a federated post's import-time
 * `_id` bears no relation to the remote `createdAt` that decides which post is
 * the root. The same fact makes an `_id` sort wrong for the author feed.
 * `boostOf` and `quoteOf` are worse still — either can point at a post imported
 * months later. So a row naming a row the same batch is inserting is not a case
 * to order around; it is a case to defer, which is what pass B does.
 *
 * Nothing in this file needs to know that — but a reader wondering why a
 * reply's parent link survives an `_id`-ordered stream should look there.
 *
 * ## What is NOT carried, stated rather than skipped
 *
 * `metadata.pollId` exists in the Mongoose schema and has NO column: the schema
 * kept only `content.pollId`. It is a DUPLICATE of a field rather than a derived
 * one, so the two could legitimately disagree and dropping the wrong one would
 * lose a poll link. This transform reads `content.pollId` only.
 *
 * **SETTLED against production, 2026-08-02 — zero posts carry the field at
 * all.** Not "zero disagree": zero of 577,091 posts in `mention-production` have
 * `metadata.pollId` present, with or without `content.pollId`. So the schema
 * does not need the column and no fallback was ever warranted.
 *
 *     db.posts.countDocuments({'metadata.pollId': {$exists: true},
 *                              'content.pollId': {$exists: false}})   // 0
 *     db.posts.countDocuments({'metadata.pollId': {$exists: true}})   // 0
 *
 * The query stays as the record of HOW this was decided, because the reasoning
 * outlives the number: a non-zero answer would have meant the SCHEMA needed the
 * column, not that this transform needed a fallback. Coalescing two fields that
 * can disagree hides the disagreement instead of resolving it, and the way to
 * settle which of two duplicates is authoritative is a count, not a guess.
 */

import { posts } from '../../schema/posts';
import {
  postAttachments,
  postAuthorships,
  postClassificationTopicRefs,
  postContentVariants,
  postMedia,
  postMentions,
  postSources,
  postVariantAltTexts,
  postVariantMedia,
} from '../../schema/postContent';
import type { CollectionPlan, Emit } from '../plan';
import { buildRow } from '../rowBuilder';
import {
  bool,
  childRowId,
  date,
  id,
  int,
  jsonObject,
  num,
  numArray,
  ownId,
  reqStr,
  str,
  strArray,
  subdocuments,
  type MongoDocument,
} from '../values';
import { timestampsCreatedFromId } from './timestamps';

/** Every classification score is a probability; the CHECK is `between 0 and 1`. */
const SCORE_PATHS = [
  ['postClassification.scores.toxicity', 'classificationScoreToxicity'],
  ['postClassification.scores.constructiveness', 'classificationScoreConstructiveness'],
  ['postClassification.scores.spam', 'classificationScoreSpam'],
  ['postClassification.scores.quality', 'classificationScoreQuality'],
  ['postClassification.scores.controversy', 'classificationScoreControversy'],
  ['postClassification.scores.negativity', 'classificationScoreNegativity'],
] as const;

const postsPlan: CollectionPlan = {
  collection: 'posts',
  table: posts,
  childTables: [
    postAuthorships,
    postContentVariants,
    postVariantMedia,
    postVariantAltTexts,
    postMedia,
    postAttachments,
    postSources,
    postMentions,
    postClassificationTopicRefs,
  ],
  enumAudits: [
    { path: 'type', column: posts.type, absentAs: 'text' },
    { path: 'visibility', column: posts.visibility, absentAs: 'public' },
    // The model's enum is three values; the COLUMN accepts four. `'restricted'`
    // is a CrowdSource enforcement state the schema added and the model never
    // learned, so auditing against the column (which is what `EnumAudit` does)
    // is both correct and wider than the model — exactly the right direction.
    { path: 'status', column: posts.status, absentAs: 'published' },
    { path: 'content.room.status', column: posts.contentRoomStatus },
    {
      path: 'postClassification.status',
      column: posts.classificationStatus,
      absentAs: 'pending',
    },
    {
      path: 'postClassification.sentiment',
      column: posts.classificationSentiment,
      absentAs: 'neutral',
    },
    {
      path: 'postClassification.intent',
      column: posts.classificationIntent,
      absentAs: 'other',
    },
    // Paths INTO arrays: `distinct` returns the elements' values, which is the
    // set each of these CHECKs constrains.
    //
    // `replyPermission` is array-VALUED but lives on `posts` itself, so it is
    // the document's own field and not a path into a child table's array — see
    // `auditMissingRequired`, which asks a different question of each.
    //
    // 147,198 production posts have no `replyPermission` at all, every one of
    // them federated: `OutboxSyncService` batch-inserts raw documents, which
    // bypasses the Mongoose default the composer path gets. `absentAs` is a
    // DECLARATION of what the transform already does (`replyPermission:
    // strArray(doc, 'replyPermission') ?? ['anyone']` below), not a new choice —
    // and `['anyone']` is what every other layer independently supplies: the
    // column's own `default array['anyone']::text[]`, the Mongoose default, the
    // request validator's `.default(['anyone'])`, and both controller paths.
    { path: 'replyPermission', column: posts.replyPermission, absentAs: 'anyone' },
    { path: 'authorship.role', column: postAuthorships.role },
    { path: 'authorship.status', column: postAuthorships.status },
    { path: 'content.variants.source', column: postContentVariants.source },
    { path: 'content.media.type', column: postMedia.type },
    { path: 'content.media.orientation', column: postMedia.orientation },
    { path: 'content.variants.media.type', column: postVariantMedia.type },
    { path: 'content.variants.media.orientation', column: postVariantMedia.orientation },
    { path: 'content.attachments.type', column: postAttachments.type },
    { path: 'content.attachments.mediaType', column: postAttachments.mediaType },
    {
      path: 'postClassification.topicRefs.type',
      column: postClassificationTopicRefs.type,
    },
  ],
  numericAudits: [
    ...SCORE_PATHS.map(([path, property]) => ({
      path,
      // Indexed off the table rather than named one by one, so a renamed column
      // is a compile error instead of an audit that quietly checks nothing.
      column: posts[property],
      constraint: 'posts_classification_scores_check',
      min: 0,
      max: 1,
      // Mongoose defaults each to 0 and the transform re-applies that, so an
      // absent score is not a finding.
      absentAs: 0,
    })),
    {
      path: 'postClassification.confidence',
      column: posts.classificationConfidence,
      constraint: 'posts_classification_scores_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    // The RANGE half of the two location CHECKs. The all-or-nothing PAIR half is
    // a cross-column invariant no audit kind can express — it is enforced in the
    // transform instead, which emits both coordinates or neither.
    {
      path: 'location.coordinates.1',
      column: posts.locationLatitude,
      constraint: 'posts_location_range_check',
      min: -90,
      max: 90,
    },
    {
      path: 'location.coordinates.0',
      column: posts.locationLongitude,
      constraint: 'posts_location_range_check',
      min: -180,
      max: 180,
    },
    {
      path: 'content.location.coordinates.1',
      column: posts.contentLocationLatitude,
      constraint: 'posts_content_location_range_check',
      min: -90,
      max: 90,
    },
    {
      path: 'content.location.coordinates.0',
      column: posts.contentLocationLongitude,
      constraint: 'posts_content_location_range_check',
      min: -180,
      max: 180,
    },
  ],
  uniquenessAudits: [
    {
      // PARTIAL (`where federation_activity_id is not null`), and it needs no
      // `where`: the audit already excludes rows with a NULL in any key part,
      // which for a single-column key IS this predicate.
      index: 'posts_federation_activity_id_key',
      key: [{ path: 'federation.activityId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    const postId = ownId(doc);
    const parentPostId = id(doc, 'parentPostId');
    const federationInReplyTo = str(doc, 'federation.inReplyTo');

    emit(
      posts,
      buildRow(
        posts,
        {
          id: postId,
          oxyUserId: str(doc, 'oxyUserId'),
          type: str(doc, 'type') ?? 'text',
          visibility: str(doc, 'visibility') ?? 'public',
          status: str(doc, 'status') ?? 'published',
          hasLinks: bool(doc, 'hasLinks') ?? false,
          isEdited: bool(doc, 'isEdited') ?? false,
          language: str(doc, 'language'),
          // Nullable on purpose: Mongo indexed it SPARSE, so only curated posts
          // carry it and `false` is not the same as absent.
          curated: bool(doc, 'curated'),
          tags: strArray(doc, 'tags'),
          hashtags: strArray(doc, 'hashtags'),
          editHistory: strArray(doc, 'editHistory'),
          replyPermission: strArray(doc, 'replyPermission') ?? ['anyone'],
          reviewReplies: bool(doc, 'reviewReplies') ?? false,
          quotesDisabled: bool(doc, 'quotesDisabled') ?? false,

          // The four self-references. Emitted normally; the runner defers them.
          boostOf: id(doc, 'boostOf'),
          quoteOf: id(doc, 'quoteOf'),
          parentPostId,
          threadId: id(doc, 'threadId'),

          // DERIVED — Mongo has no such field. See the module docblock.
          isReply: parentPostId !== null || federationInReplyTo !== null,

          scheduledFor: date(doc, 'scheduledFor'),

          statsLikesCount: int(doc, 'stats.likesCount') ?? 0,
          statsDownvotesCount: int(doc, 'stats.downvotesCount') ?? 0,
          statsBoostsCount: int(doc, 'stats.boostsCount') ?? 0,
          statsFederatedBoostsCount: int(doc, 'stats.federatedBoostsCount') ?? 0,
          statsCommentsCount: int(doc, 'stats.commentsCount') ?? 0,
          statsViewsCount: int(doc, 'stats.viewsCount') ?? 0,
          statsSharesCount: int(doc, 'stats.sharesCount') ?? 0,
          statsSavesCount: int(doc, 'stats.savesCount') ?? 0,

          metadataIsSensitive: bool(doc, 'metadata.isSensitive') ?? false,
          metadataIsPinned: bool(doc, 'metadata.isPinned') ?? false,
          metadataIsBoosted: bool(doc, 'metadata.isBoosted') ?? false,
          metadataIsCommented: bool(doc, 'metadata.isCommented') ?? false,
          metadataIsFollowingAuthor: bool(doc, 'metadata.isFollowingAuthor') ?? false,
          metadataAuthorBlocked: bool(doc, 'metadata.authorBlocked') ?? false,
          metadataAuthorMuted: bool(doc, 'metadata.authorMuted') ?? false,
          metadataHideEngagementCounts: bool(doc, 'metadata.hideEngagementCounts') ?? false,
          // Mongo stored these as ABSENT or `true` and every reader tests
          // truthiness, so `?? false` is the faithful port rather than a guess.
          metadataCollabFederationDeferred:
            bool(doc, 'metadata.collabFederationDeferred') ?? false,
          metadataFederationDelivered: bool(doc, 'metadata.federationDelivered') ?? false,
          // `metadata.pollId` is deliberately NOT read — see the docblock.

          federationActivityId: str(doc, 'federation.activityId'),
          federationActorUri: str(doc, 'federation.actorUri'),
          federationInReplyTo,
          federationUrl: str(doc, 'federation.url'),
          federationSensitive: bool(doc, 'federation.sensitive'),
          federationSpoilerText: str(doc, 'federation.spoilerText'),

          contentPollId: str(doc, 'content.pollId'),
          contentArticleId: str(doc, 'content.article.articleId'),
          contentArticleTitle: str(doc, 'content.article.title'),
          contentArticleExcerpt: str(doc, 'content.article.excerpt'),
          contentEventId: str(doc, 'content.event.eventId'),
          contentEventName: str(doc, 'content.event.name'),
          // Mongo typed this a STRING holding an ISO date; the column is a
          // `timestamptz`. `date()` parses the three shapes Mongo produces and
          // THROWS on an unparseable one rather than storing an Invalid Date,
          // which Postgres would reject far from the document that caused it.
          contentEventDate: date(doc, 'content.event.date'),
          contentEventLocation: str(doc, 'content.event.location'),
          contentEventDescription: str(doc, 'content.event.description'),
          contentRoomId: str(doc, 'content.room.roomId'),
          contentRoomTitle: str(doc, 'content.room.title'),
          contentRoomStatus: str(doc, 'content.room.status'),
          contentRoomTopic: str(doc, 'content.room.topic'),
          contentRoomHost: str(doc, 'content.room.host'),
          contentPodcastSyraId: str(doc, 'content.podcast.syraPodcastId'),
          contentPodcastTitle: str(doc, 'content.podcast.title'),
          contentPodcastAuthor: str(doc, 'content.podcast.author'),
          contentPodcastArtworkUrl: str(doc, 'content.podcast.artworkUrl'),
          contentPodcastShowUrl: str(doc, 'content.podcast.showUrl'),

          ...coordinates(doc, 'content.location', 'contentLocation'),
          contentLocationAddress: str(doc, 'content.location.address'),
          ...coordinates(doc, 'location', 'location'),
          locationAddress: str(doc, 'location.address'),
          // `geo` and `content_geo` are GENERATED from those pairs. Naming
          // either here throws in `buildRow`, which is the point: there is no
          // Mongo value to carry across and a transform that tried would fail in
          // a unit test rather than on a `428C9` at hour three.

          classificationTopics: strArray(doc, 'postClassification.topics'),
          classificationLanguages: strArray(doc, 'postClassification.languages'),
          classificationRegion: str(doc, 'postClassification.region'),
          classificationHashtagsNorm: strArray(doc, 'postClassification.hashtagsNorm'),
          classificationSensitive: bool(doc, 'postClassification.sensitive'),
          classificationVersion: int(doc, 'postClassification.version'),
          classificationSentiment: str(doc, 'postClassification.sentiment') ?? 'neutral',
          classificationIntent: str(doc, 'postClassification.intent') ?? 'other',
          classificationScoreToxicity: num(doc, 'postClassification.scores.toxicity') ?? 0,
          classificationScoreConstructiveness:
            num(doc, 'postClassification.scores.constructiveness') ?? 0,
          classificationScoreSpam: num(doc, 'postClassification.scores.spam') ?? 0,
          classificationScoreQuality: num(doc, 'postClassification.scores.quality') ?? 0,
          classificationScoreControversy:
            num(doc, 'postClassification.scores.controversy') ?? 0,
          classificationScoreNegativity: num(doc, 'postClassification.scores.negativity') ?? 0,
          classificationConfidence: num(doc, 'postClassification.confidence') ?? 0,
          classificationStatus: str(doc, 'postClassification.status') ?? 'pending',
          classificationAttempts: int(doc, 'postClassification.attempts') ?? 0,
          classificationClassifiedAt: date(doc, 'postClassification.classifiedAt'),

          // DERIVED from `_id` when absent — six production posts have no
          // `createdAt` at all, and this column is NOT NULL with a DEFAULT, so
          // the silent outcome is `now()`. See `timestampsCreatedFromId`.
          ...timestampsCreatedFromId(doc),
        },
        postId
      )
    );

    emitAuthorships(doc, postId, emit);
    emitVariants(doc, postId, emit);
    emitMedia(doc, postId, emit);
    emitAttachments(doc, postId, emit);
    emitSources(doc, postId, emit);
    emitMentions(doc, postId, emit);
    emitTopicRefs(doc, postId, emit);
  },
};

/**
 * One GeoJSON coordinate pair → the `latitude`/`longitude` column pair.
 *
 * Written ONCE and used for both pairs, because the ordering is the mistake this
 * plan is most likely to make silently: GeoJSON is **`[longitude, latitude]`**,
 * so `coordinates[0]` is the LONGITUDE. Reading it into `latitude` produces two
 * plausible numbers and a mirrored world.
 *
 * The pair is all-or-nothing. `posts_location_pair_check` asserts
 * `(latitude is null) = (longitude is null)`, and Mongo allowed both an empty
 * `coordinates: []` and half-written pairs — `outbox.service.ts` had to strip
 * those by hand on the federated insert path. Anything that is not exactly two
 * finite numbers therefore becomes NULL/NULL rather than half a location.
 */
function coordinates(
  doc: MongoDocument,
  path: string,
  property: 'location' | 'contentLocation'
): Record<string, unknown> {
  const pair = numArray(doc, `${path}.coordinates`);
  const latitudeKey = `${property}Latitude`;
  const longitudeKey = `${property}Longitude`;
  if (pair === null || pair.length !== 2) {
    return { [latitudeKey]: null, [longitudeKey]: null };
  }
  return { [latitudeKey]: pair[1], [longitudeKey]: pair[0] };
}

/** `authorship[]` → `post_authorships`. `_id: false`, so ids are derived. */
function emitAuthorships(doc: MongoDocument, postId: string, emit: Emit): void {
  for (const [entry, position] of subdocuments(doc, 'authorship')) {
    emit(
      postAuthorships,
      buildRow(
        postAuthorships,
        {
          id: childRowId(entry, postId, 'authorship', position),
          postId,
          oxyUserId: reqStr(entry, 'oxyUserId'),
          role: reqStr(entry, 'role'),
          status: reqStr(entry, 'status'),
          invitedAt: date(entry, 'invitedAt'),
          respondedAt: date(entry, 'respondedAt'),
        },
        postId
      )
    );
  }
}

/**
 * `content.variants[]` → `post_content_variants`, plus each variant's own
 * `media[]` and `alt` map.
 *
 * The variant's Mongo field is `text`; the column is `body`. Its `createdAt` is
 * a STRING in Mongo and a `timestamptz` here — `date()` parses it and throws on
 * an unparseable value, which the schema explicitly asked for ("a value that is
 * not a date is not a date in either store").
 */
function emitVariants(doc: MongoDocument, postId: string, emit: Emit): void {
  for (const [variant, position] of subdocuments(doc, 'content.variants')) {
    const variantId = childRowId(variant, postId, 'content.variants', position);

    emit(
      postContentVariants,
      buildRow(
        postContentVariants,
        {
          id: variantId,
          postId,
          position,
          tag: str(variant, 'tag'),
          source: reqStr(variant, 'source'),
          body: str(variant, 'text') ?? '',
          articleTitle: str(variant, 'article.title'),
          articleBody: str(variant, 'article.body'),
          articleExcerpt: str(variant, 'article.excerpt'),
          variantCreatedAt: date(variant, 'createdAt'),
          // `searchVector` is GENERATED from `body`.
        },
        postId
      )
    );

    for (const [item, mediaPosition] of subdocuments(variant, 'media')) {
      emit(
        postVariantMedia,
        buildRow(
          postVariantMedia,
          {
            id: childRowId(item, variantId, 'media', mediaPosition),
            variantId,
            position: mediaPosition,
            ...mediaColumns(item),
          },
          postId
        )
      );
    }

    // `alt` is a MAP of media id → description, not an array. Its keys are the
    // ids, so the row id derives from the key rather than an ordinal — a map has
    // no order to preserve, and keying on position would change every id when a
    // key is added.
    const alt = jsonObject(variant, 'alt');
    for (const [mediaId, description] of Object.entries(alt ?? {})) {
      if (typeof description !== 'string') continue;
      emit(
        postVariantAltTexts,
        buildRow(
          postVariantAltTexts,
          {
            id: childRowId({}, variantId, `alt.${mediaId}`, 0),
            variantId,
            mediaId,
            description,
          },
          postId
        )
      );
    }
  }
}

/** `content.media[]` → `post_media`. */
function emitMedia(doc: MongoDocument, postId: string, emit: Emit): void {
  for (const [item, position] of subdocuments(doc, 'content.media')) {
    emit(
      postMedia,
      buildRow(
        postMedia,
        {
          id: childRowId(item, postId, 'content.media', position),
          postId,
          position,
          ...mediaColumns(item),
        },
        postId
      )
    );
  }
}

/**
 * The media columns `post_media` and `post_variant_media` share.
 *
 * Both tables carry the identical field set, so the mapping is written once —
 * a second copy would be the place the two silently diverge. `id` in Mongo is
 * the Oxy FILE id (or, for a federated item the media cache never rewrote, a
 * URL), and the column is `mediaId` to say so.
 */
function mediaColumns(item: MongoDocument): Record<string, unknown> {
  return {
    mediaId: reqStr(item, 'id'),
    type: reqStr(item, 'type'),
    alt: str(item, 'alt'),
    width: int(item, 'width'),
    height: int(item, 'height'),
    durationSec: num(item, 'durationSec'),
    sizeBytes: int(item, 'sizeBytes'),
    orientation: str(item, 'orientation'),
    aspectRatio: num(item, 'aspectRatio'),
    mime: str(item, 'mime'),
    remoteUrl: str(item, 'remoteUrl'),
    cachedFromFederation: bool(item, 'cachedFromFederation'),
  };
}

/** `content.attachments[]` → `post_attachments`. `_id: false`. */
function emitAttachments(doc: MongoDocument, postId: string, emit: Emit): void {
  for (const [attachment, position] of subdocuments(doc, 'content.attachments')) {
    emit(
      postAttachments,
      buildRow(
        postAttachments,
        {
          id: childRowId(attachment, postId, 'content.attachments', position),
          postId,
          position,
          type: reqStr(attachment, 'type'),
          // Mongo's `id`, required only when `type === 'media'` — so it is
          // NULLABLE here and stays NULL for every other kind.
          attachmentId: str(attachment, 'id'),
          mediaType: str(attachment, 'mediaType'),
        },
        postId
      )
    );
  }
}

/** `content.sources[]` → `post_sources`. Inline array, so Mongoose kept an `_id`. */
function emitSources(doc: MongoDocument, postId: string, emit: Emit): void {
  for (const [entry, position] of subdocuments(doc, 'content.sources')) {
    emit(
      postSources,
      buildRow(
        postSources,
        {
          id: childRowId(entry, postId, 'content.sources', position),
          postId,
          position,
          url: reqStr(entry, 'url'),
          title: str(entry, 'title'),
        },
        postId
      )
    );
  }
}

/**
 * `mentions[]` → `post_mentions`.
 *
 * A scalar array of Oxy account ids with no ordinal column on the table — the
 * unique key is `(post_id, oxy_user_id)`, so the SET is what matters.
 *
 * The dedup is NOT protecting the insert. Every insert is `ON CONFLICT DO
 * NOTHING`, so a duplicate would be absorbed silently and the table would end
 * up correct either way — measured, by removing this guard and watching the row
 * set come out identical.
 *
 * What it protects is the VERIFIER. `verifyBackfill` computes each child
 * table's expected count by re-running this transform and comparing it against
 * what Postgres holds; emitting three rows for two distinct mentions makes that
 * comparison fail on every affected post, and a count mismatch is exactly the
 * signal that is supposed to mean "the copy lost something". A guard that turns
 * a real alarm into a routine one is worse than no guard, so the emission has
 * to match the row set rather than the source array.
 */
function emitMentions(doc: MongoDocument, postId: string, emit: Emit): void {
  const seen = new Set<string>();
  for (const [index, oxyUserId] of (strArray(doc, 'mentions') ?? []).entries()) {
    if (seen.has(oxyUserId)) continue;
    seen.add(oxyUserId);
    emit(
      postMentions,
      buildRow(
        postMentions,
        {
          id: childRowId({}, postId, 'mentions', index),
          postId,
          oxyUserId,
        },
        postId
      )
    );
  }
}

/**
 * `postClassification.topicRefs[]` → `post_classification_topic_refs`.
 *
 * Same dedup argument as mentions, and for the same reason — the unique key is
 * `(post_id, name)`, `ON CONFLICT DO NOTHING` would absorb a duplicate at the
 * insert, and it is the verifier's count comparison that the emission has to
 * match.
 */
function emitTopicRefs(doc: MongoDocument, postId: string, emit: Emit): void {
  const seen = new Set<string>();
  for (const [ref, position] of subdocuments(doc, 'postClassification.topicRefs')) {
    const name = reqStr(ref, 'name');
    if (seen.has(name)) continue;
    seen.add(name);
    emit(
      postClassificationTopicRefs,
      buildRow(
        postClassificationTopicRefs,
        {
          id: childRowId(ref, postId, 'postClassification.topicRefs', position),
          postId,
          name,
          topicId: str(ref, 'topicId'),
          relevance: int(ref, 'relevance'),
          type: str(ref, 'type'),
        },
        postId
      )
    );
  }
}

/** The posts plan. */
export const POST_PLANS: readonly CollectionPlan[] = [postsPlan];
