/**
 * Candidate-post reader — the Postgres replacement for Mongo's `FEED_FIELDS`
 * projection.
 *
 * ## Why this module has to exist at all
 *
 * Mongo handed every feed source a single document whose nested subdocuments
 * (`stats`, `metadata`, `federation`, `content`, `postClassification`) and
 * embedded arrays (`authorship`, `mentions`, `content.media`, …) were already
 * shaped exactly like the `CandidatePost` the ranking, safety, slicing and
 * hydration layers consume. The Postgres schema deliberately decomposes that
 * document — scalar subdocuments became prefixed columns, every array became a
 * child table (`db/schema/CONVENTIONS.md`, "Arrays and objects") — because a
 * `jsonb` blob would be unqueryable by exactly the predicates the feed engine
 * runs against it on every request.
 *
 * So the decomposition is right, and it means SOMETHING has to put the document
 * back together for the consumers. That is this module, and it is the ONLY place
 * that mapping exists: a second copy would be free to disagree about whether
 * `federation` is absent or present-and-empty, which is a question three
 * different predicates key on.
 *
 * ## One query per child table, never a per-row fetch
 *
 * `loadCandidatePosts` takes the rows a source already selected and issues ONE
 * additional `where post_id = any(...)` query per child table, then joins them in
 * memory by id. That is the same shape Mention already uses everywhere else —
 * the codebase has 41 aggregation pipelines and ZERO `$lookup`, with all
 * cross-collection work done as id maps in application code — so this is the
 * existing architecture expressed in SQL, not a new one.
 *
 * It is deliberately NOT a `json_agg` correlated subquery per child: that shape
 * is where `db/casing.ts`'s bare-column trap bites hardest (a drizzle column
 * interpolated into `sql` renders unqualified when its table is not in that
 * statement's `FROM`, so the correlation silently compares two columns of the
 * subquery's own table and returns nothing, with no error). Batched `inArray`
 * lookups have no correlated predicate to get wrong.
 *
 * ## Absence is a value here
 *
 * `federation` must be UNDEFINED for a local post, not an object of nulls.
 * Three separate predicates read it that way — the `local` branch of the
 * `instance` source, `isReplyPost` via `federation?.inReplyTo`, and
 * `isSensitivePost` via `federation?.sensitive` — and an always-present object
 * would make the first of them match every post on the instance. The same
 * applies to the optional `content` leaves: an absent poll is no `pollId` key,
 * not `pollId: null`.
 */

import { inArray, asc, type SQL } from 'drizzle-orm';
import {
  posts,
  postAuthorships,
  postContentVariants,
  postMedia,
  postVariantMedia,
  postVariantAltTexts,
  postAttachments,
  postSources,
  postMentions,
  postClassificationTopicRefs,
} from '../schema';
import type { Database, DatabaseOrTransaction } from '../postgres';
import type { CandidatePost } from '../../mtn/feed/engine/types';

/**
 * The column set every feed source selects — the direct analogue of Mongo's
 * `FEED_FIELDS` string, and the reason sources cannot accidentally select the
 * whole row (which `db/schema/protectedColumns.ts` exists to prevent, and which
 * would drag `posts` columns the feed has no business reading).
 *
 * Declared as a `const` object rather than a helper call so its inferred type IS
 * the row type: adding a column here immediately types it onto
 * {@link CandidatePostRow} and a consumer that forgets to map it fails `tsc`.
 */
export const candidatePostColumns = {
  id: posts.id,
  oxyUserId: posts.oxyUserId,
  type: posts.type,
  visibility: posts.visibility,
  status: posts.status,
  language: posts.language,
  hashtags: posts.hashtags,
  parentPostId: posts.parentPostId,
  boostOf: posts.boostOf,
  quoteOf: posts.quoteOf,
  threadId: posts.threadId,
  createdAt: posts.createdAt,
  updatedAt: posts.updatedAt,

  statsLikesCount: posts.statsLikesCount,
  statsDownvotesCount: posts.statsDownvotesCount,
  statsBoostsCount: posts.statsBoostsCount,
  statsFederatedBoostsCount: posts.statsFederatedBoostsCount,
  statsCommentsCount: posts.statsCommentsCount,
  statsViewsCount: posts.statsViewsCount,
  statsSharesCount: posts.statsSharesCount,
  statsSavesCount: posts.statsSavesCount,

  metadataIsSensitive: posts.metadataIsSensitive,
  metadataIsPinned: posts.metadataIsPinned,
  metadataIsBoosted: posts.metadataIsBoosted,
  metadataIsCommented: posts.metadataIsCommented,
  metadataIsFollowingAuthor: posts.metadataIsFollowingAuthor,
  metadataAuthorBlocked: posts.metadataAuthorBlocked,
  metadataAuthorMuted: posts.metadataAuthorMuted,
  metadataHideEngagementCounts: posts.metadataHideEngagementCounts,

  federationActivityId: posts.federationActivityId,
  federationActorUri: posts.federationActorUri,
  federationInReplyTo: posts.federationInReplyTo,
  federationUrl: posts.federationUrl,
  federationSensitive: posts.federationSensitive,
  federationSpoilerText: posts.federationSpoilerText,

  contentPollId: posts.contentPollId,
  contentArticleId: posts.contentArticleId,
  contentArticleTitle: posts.contentArticleTitle,
  contentArticleExcerpt: posts.contentArticleExcerpt,
  contentEventId: posts.contentEventId,
  contentEventName: posts.contentEventName,
  contentEventDate: posts.contentEventDate,
  contentEventLocation: posts.contentEventLocation,
  contentEventDescription: posts.contentEventDescription,
  contentRoomId: posts.contentRoomId,
  contentRoomTitle: posts.contentRoomTitle,
  contentRoomStatus: posts.contentRoomStatus,
  contentRoomTopic: posts.contentRoomTopic,
  contentRoomHost: posts.contentRoomHost,
  contentPodcastSyraId: posts.contentPodcastSyraId,
  contentPodcastTitle: posts.contentPodcastTitle,
  contentPodcastAuthor: posts.contentPodcastAuthor,
  contentPodcastArtworkUrl: posts.contentPodcastArtworkUrl,
  contentPodcastShowUrl: posts.contentPodcastShowUrl,
  contentLocationLatitude: posts.contentLocationLatitude,
  contentLocationLongitude: posts.contentLocationLongitude,
  contentLocationAddress: posts.contentLocationAddress,
  locationLatitude: posts.locationLatitude,
  locationLongitude: posts.locationLongitude,
  locationAddress: posts.locationAddress,

  classificationTopics: posts.classificationTopics,
  classificationLanguages: posts.classificationLanguages,
  classificationRegion: posts.classificationRegion,
  classificationSensitive: posts.classificationSensitive,
  classificationVersion: posts.classificationVersion,
  classificationSentiment: posts.classificationSentiment,
  classificationIntent: posts.classificationIntent,
  classificationStatus: posts.classificationStatus,
  classificationScoreToxicity: posts.classificationScoreToxicity,
  classificationScoreConstructiveness: posts.classificationScoreConstructiveness,
  classificationScoreSpam: posts.classificationScoreSpam,
  classificationScoreQuality: posts.classificationScoreQuality,
  classificationScoreControversy: posts.classificationScoreControversy,
  classificationScoreNegativity: posts.classificationScoreNegativity,
  classificationConfidence: posts.classificationConfidence,
} as const;

/**
 * One `posts` row as {@link candidatePostColumns} selects it.
 *
 * Nullability is read from each column's own `notNull` flag rather than taken
 * from `['_']['data']` alone — drizzle keeps the two separate, so the naive
 * mapped type claims every column is non-null and a `null` from the database
 * then flows into the assembled DTO with `tsc` having raised nothing.
 */
export type CandidatePostRow = {
  [K in keyof typeof candidatePostColumns]: (typeof candidatePostColumns)[K]['_']['notNull'] extends true
    ? (typeof candidatePostColumns)[K]['_']['data']
    : (typeof candidatePostColumns)[K]['_']['data'] | null;
};

/** A media item as the DTO shapes it (`@mention/shared-types` `MediaItem`). */
interface AssembledMedia {
  id: string;
  type: 'image' | 'video' | 'gif';
  alt?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
  orientation?: 'portrait' | 'landscape' | 'square';
  aspectRatio?: number;
  mime?: string;
  remoteUrl?: string;
  cachedFromFederation?: boolean;
}

/** A media child row, from either the shared set or a variant override. */
interface MediaChildRow {
  mediaId: string;
  type: 'image' | 'video' | 'gif';
  alt: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  sizeBytes: number | null;
  orientation: 'portrait' | 'landscape' | 'square' | null;
  aspectRatio: number | null;
  mime: string | null;
  remoteUrl: string | null;
  cachedFromFederation: boolean | null;
}

/**
 * Drop the keys whose value is `null`.
 *
 * Mongo stored an absent optional field by OMITTING it; Postgres stores it as a
 * NULL column. Emitting `{ alt: null }` where Mongo emitted `{}` changes the
 * wire format for every optional leaf on every post — `alt` in particular is
 * read by the client as "there is alt text", so a null would light up the ALT
 * badge on media that has none.
 */
function omitNulls<T extends Record<string, unknown>>(value: T): WithoutNulls<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && entry !== undefined) out[key] = entry;
  }
  return out as WithoutNulls<T>;
}

/**
 * Every key optional, and `null` REMOVED from every value type.
 *
 * Dropping `null` at the type level is the point: `Partial<T>` alone keeps
 * `string | null | undefined`, which then fails to satisfy DTO fields declared
 * `string | undefined` — and the tempting fix is a cast, which would re-admit
 * the runtime nulls this helper exists to strip.
 */
type WithoutNulls<T> = { [K in keyof T]?: Exclude<T[K], null | undefined> };

/** Shape a media child row into the DTO's `MediaItem`. */
function assembleMedia(row: MediaChildRow): AssembledMedia {
  return {
    id: row.mediaId,
    type: row.type,
    ...omitNulls({
      alt: row.alt,
      width: row.width,
      height: row.height,
      durationSec: row.durationSec,
      sizeBytes: row.sizeBytes,
      orientation: row.orientation,
      aspectRatio: row.aspectRatio,
      mime: row.mime,
      remoteUrl: row.remoteUrl,
      cachedFromFederation: row.cachedFromFederation,
    }),
  };
}

/** Group child rows by their owning key, preserving the query's order. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const bucket = map.get(id);
    if (bucket) bucket.push(row);
    else map.set(id, [row]);
  }
  return map;
}

/**
 * Reassemble `CandidatePost` documents from selected `posts` rows.
 *
 * Order is PRESERVED: the returned array matches `rows` element for element, so
 * a caller that already applied its own `ORDER BY` (every ranked and
 * chronological source does) does not have to re-sort. Returning them in child-
 * query order instead would silently scramble every feed.
 */
export async function loadCandidatePosts(
  db: DatabaseOrTransaction,
  rows: CandidatePostRow[],
): Promise<CandidatePost[]> {
  if (rows.length === 0) return [];

  const postIds = rows.map((row) => row.id);

  const [
    authorshipRows,
    variantRows,
    mediaRows,
    attachmentRows,
    sourceRows,
    mentionRows,
    topicRefRows,
  ] = await Promise.all([
    db
      .select({
        postId: postAuthorships.postId,
        oxyUserId: postAuthorships.oxyUserId,
        role: postAuthorships.role,
        status: postAuthorships.status,
        invitedAt: postAuthorships.invitedAt,
        respondedAt: postAuthorships.respondedAt,
      })
      .from(postAuthorships)
      .where(inArray(postAuthorships.postId, postIds)),
    db
      .select({
        id: postContentVariants.id,
        postId: postContentVariants.postId,
        position: postContentVariants.position,
        tag: postContentVariants.tag,
        source: postContentVariants.source,
        body: postContentVariants.body,
        articleTitle: postContentVariants.articleTitle,
        articleBody: postContentVariants.articleBody,
        articleExcerpt: postContentVariants.articleExcerpt,
        variantCreatedAt: postContentVariants.variantCreatedAt,
      })
      .from(postContentVariants)
      .where(inArray(postContentVariants.postId, postIds))
      .orderBy(asc(postContentVariants.postId), asc(postContentVariants.position)),
    db
      .select({
        postId: postMedia.postId,
        mediaId: postMedia.mediaId,
        type: postMedia.type,
        alt: postMedia.alt,
        width: postMedia.width,
        height: postMedia.height,
        durationSec: postMedia.durationSec,
        sizeBytes: postMedia.sizeBytes,
        orientation: postMedia.orientation,
        aspectRatio: postMedia.aspectRatio,
        mime: postMedia.mime,
        remoteUrl: postMedia.remoteUrl,
        cachedFromFederation: postMedia.cachedFromFederation,
      })
      .from(postMedia)
      .where(inArray(postMedia.postId, postIds))
      .orderBy(asc(postMedia.postId), asc(postMedia.position)),
    db
      .select({
        postId: postAttachments.postId,
        type: postAttachments.type,
        attachmentId: postAttachments.attachmentId,
        mediaType: postAttachments.mediaType,
      })
      .from(postAttachments)
      .where(inArray(postAttachments.postId, postIds))
      .orderBy(asc(postAttachments.postId), asc(postAttachments.position)),
    db
      .select({
        postId: postSources.postId,
        url: postSources.url,
        title: postSources.title,
      })
      .from(postSources)
      .where(inArray(postSources.postId, postIds))
      .orderBy(asc(postSources.postId), asc(postSources.position)),
    db
      .select({ postId: postMentions.postId, oxyUserId: postMentions.oxyUserId })
      .from(postMentions)
      .where(inArray(postMentions.postId, postIds)),
    db
      .select({
        postId: postClassificationTopicRefs.postId,
        name: postClassificationTopicRefs.name,
        topicId: postClassificationTopicRefs.topicId,
        relevance: postClassificationTopicRefs.relevance,
        type: postClassificationTopicRefs.type,
      })
      .from(postClassificationTopicRefs)
      .where(inArray(postClassificationTopicRefs.postId, postIds)),
  ]);

  // Variant-owned children key off the VARIANT id, so they can only be fetched
  // once the variant ids are known — hence a second round rather than an eighth
  // entry in the batch above.
  const variantIds = variantRows.map((variant) => variant.id);
  const [variantMediaRows, variantAltRows] = variantIds.length
    ? await Promise.all([
        db
          .select({
            variantId: postVariantMedia.variantId,
            mediaId: postVariantMedia.mediaId,
            type: postVariantMedia.type,
            alt: postVariantMedia.alt,
            width: postVariantMedia.width,
            height: postVariantMedia.height,
            durationSec: postVariantMedia.durationSec,
            sizeBytes: postVariantMedia.sizeBytes,
            orientation: postVariantMedia.orientation,
            aspectRatio: postVariantMedia.aspectRatio,
            mime: postVariantMedia.mime,
            remoteUrl: postVariantMedia.remoteUrl,
            cachedFromFederation: postVariantMedia.cachedFromFederation,
          })
          .from(postVariantMedia)
          .where(inArray(postVariantMedia.variantId, variantIds))
          .orderBy(asc(postVariantMedia.variantId), asc(postVariantMedia.position)),
        db
          .select({
            variantId: postVariantAltTexts.variantId,
            mediaId: postVariantAltTexts.mediaId,
            description: postVariantAltTexts.description,
          })
          .from(postVariantAltTexts)
          .where(inArray(postVariantAltTexts.variantId, variantIds)),
      ])
    : [[], []];

  const authorshipByPost = groupBy(authorshipRows, (row) => row.postId);
  const variantsByPost = groupBy(variantRows, (row) => row.postId);
  const mediaByPost = groupBy(mediaRows, (row) => row.postId);
  const attachmentsByPost = groupBy(attachmentRows, (row) => row.postId);
  const sourcesByPost = groupBy(sourceRows, (row) => row.postId);
  const mentionsByPost = groupBy(mentionRows, (row) => row.postId);
  const topicRefsByPost = groupBy(topicRefRows, (row) => row.postId);
  const variantMediaByVariant = groupBy(variantMediaRows, (row) => row.variantId);
  const variantAltByVariant = groupBy(variantAltRows, (row) => row.variantId);

  return rows.map((row) => {
    const variants = (variantsByPost.get(row.id) ?? []).map((variant) => {
      const overrideMedia = variantMediaByVariant.get(variant.id) ?? [];
      const altRows = variantAltByVariant.get(variant.id) ?? [];
      const alt = altRows.length
        ? Object.fromEntries(altRows.map((entry) => [entry.mediaId, entry.description]))
        : undefined;
      const article =
        variant.articleTitle !== null
        || variant.articleBody !== null
        || variant.articleExcerpt !== null
          ? omitNulls({
              title: variant.articleTitle,
              body: variant.articleBody,
              excerpt: variant.articleExcerpt,
            })
          : undefined;
      return {
        // The COLUMN is `body` and the DTO field is `text`. The rename is
        // deliberate on the schema side (a field literally named `language`
        // inside a Mongo text-indexed document is read as a stemmer override;
        // `body` avoided a matching trap) and the wire contract still says
        // `text`, so the mapping lives here rather than leaking either name.
        text: variant.body,
        source: variant.source,
        ...omitNulls({ tag: variant.tag }),
        ...(alt ? { alt } : {}),
        ...(overrideMedia.length ? { media: overrideMedia.map(assembleMedia) } : {}),
        ...(article ? { article } : {}),
        ...(variant.variantCreatedAt
          ? { createdAt: variant.variantCreatedAt.toISOString() }
          : {}),
      };
    });

    const media = (mediaByPost.get(row.id) ?? []).map(assembleMedia);
    const attachments = (attachmentsByPost.get(row.id) ?? []).map((attachment) =>
      ({
        type: attachment.type,
        ...omitNulls({ id: attachment.attachmentId, mediaType: attachment.mediaType }),
      }));
    const sources = (sourcesByPost.get(row.id) ?? []).map((source) =>
      ({ url: source.url, ...omitNulls({ title: source.title }) }));
    const topicRefs = (topicRefsByPost.get(row.id) ?? []).map((ref) =>
      ({ name: ref.name, ...omitNulls({ topicId: ref.topicId, relevance: ref.relevance, type: ref.type }) }));

    const hasFederation =
      row.federationActivityId !== null
      || row.federationActorUri !== null
      || row.federationInReplyTo !== null
      || row.federationUrl !== null
      || row.federationSensitive !== null
      || row.federationSpoilerText !== null;

    const contentLocation =
      row.contentLocationLatitude !== null && row.contentLocationLongitude !== null
        ? {
            type: 'Point' as const,
            coordinates: [row.contentLocationLongitude, row.contentLocationLatitude],
            ...omitNulls({ address: row.contentLocationAddress }),
          }
        : undefined;
    const location =
      row.locationLatitude !== null && row.locationLongitude !== null
        ? {
            type: 'Point' as const,
            coordinates: [row.locationLongitude, row.locationLatitude],
            ...omitNulls({ address: row.locationAddress }),
          }
        : undefined;

    // Hoisted out of the literal below rather than inlined. `CandidatePost`
    // inherits `metadata` from `FeedSafetyPostShape`, which declares only the
    // ONE field safety reads (`isSensitive`) — it is documented there as "the
    // minimal post shape". A fresh object literal assigned to it therefore trips
    // excess-property checking on the seven other fields the feed genuinely
    // carries. Widening `FeedSafetyPostShape` would make the safety contract
    // claim to know about fields it must not depend on, and a cast would silence
    // a real check; a non-fresh object is assignable on its structure alone,
    // which is both sound and honest about which type under-describes the value.
    const metadata = {
      isSensitive: row.metadataIsSensitive,
      isPinned: row.metadataIsPinned,
      isBoosted: row.metadataIsBoosted,
      isCommented: row.metadataIsCommented,
      isFollowingAuthor: row.metadataIsFollowingAuthor,
      authorBlocked: row.metadataAuthorBlocked,
      authorMuted: row.metadataAuthorMuted,
      hideEngagementCounts: row.metadataHideEngagementCounts,
    };

    const candidate: CandidatePost = {
      _id: row.id,
      ...omitNulls({ oxyUserId: row.oxyUserId, language: row.language }),
      type: row.type,
      visibility: row.visibility,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      parentPostId: row.parentPostId,
      boostOf: row.boostOf,
      quoteOf: row.quoteOf,
      threadId: row.threadId,
      hashtags: row.hashtags ?? [],
      mentions: (mentionsByPost.get(row.id) ?? []).map((mention) => mention.oxyUserId),
      authorship: (authorshipByPost.get(row.id) ?? []).map((entry) =>
        ({
          oxyUserId: entry.oxyUserId,
          role: entry.role,
          status: entry.status,
          ...omitNulls({ invitedAt: entry.invitedAt, respondedAt: entry.respondedAt }),
        })),
      stats: {
        likesCount: row.statsLikesCount,
        downvotesCount: row.statsDownvotesCount,
        boostsCount: row.statsBoostsCount,
        federatedBoostsCount: row.statsFederatedBoostsCount,
        commentsCount: row.statsCommentsCount,
        viewsCount: row.statsViewsCount,
        sharesCount: row.statsSharesCount,
        savesCount: row.statsSavesCount,
      },
      metadata,
      content: {
        variants,
        media,
        attachments,
        sources,
        ...omitNulls({
          pollId: row.contentPollId,
          articleId: row.contentArticleId,
          articleTitle: row.contentArticleTitle,
          articleExcerpt: row.contentArticleExcerpt,
          eventId: row.contentEventId,
          eventName: row.contentEventName,
          eventLocation: row.contentEventLocation,
          eventDescription: row.contentEventDescription,
          roomId: row.contentRoomId,
          roomTitle: row.contentRoomTitle,
          roomStatus: row.contentRoomStatus,
          roomTopic: row.contentRoomTopic,
          roomHost: row.contentRoomHost,
          podcastSyraId: row.contentPodcastSyraId,
          podcastTitle: row.contentPodcastTitle,
          podcastAuthor: row.contentPodcastAuthor,
          podcastArtworkUrl: row.contentPodcastArtworkUrl,
          podcastShowUrl: row.contentPodcastShowUrl,
        }),
        ...(row.contentEventDate ? { eventDate: row.contentEventDate.toISOString() } : {}),
        ...(contentLocation ? { location: contentLocation } : {}),
      },
      postClassification: {
        topics: row.classificationTopics ?? [],
        languages: row.classificationLanguages ?? [],
        sentiment: row.classificationSentiment,
        intent: row.classificationIntent,
        status: row.classificationStatus,
        scores: {
          toxicity: row.classificationScoreToxicity,
          constructiveness: row.classificationScoreConstructiveness,
          spam: row.classificationScoreSpam,
          quality: row.classificationScoreQuality,
          controversy: row.classificationScoreControversy,
          negativity: row.classificationScoreNegativity,
        },
        confidence: row.classificationConfidence,
        ...omitNulls({
          region: row.classificationRegion,
          sensitive: row.classificationSensitive,
          version: row.classificationVersion,
        }),
        ...(topicRefs.length ? { topicRefs } : {}),
      },
      ...(hasFederation
        ? {
            federation: omitNulls({
              activityId: row.federationActivityId,
              actorUri: row.federationActorUri,
              inReplyTo: row.federationInReplyTo,
              url: row.federationUrl,
              sensitive: row.federationSensitive,
              spoilerText: row.federationSpoilerText,
            }),
          }
        : {}),
      ...(location ? { location } : {}),
    };

    return candidate;
  });
}

/**
 * Select `posts` rows with the candidate column set and reassemble them.
 *
 * The single entry point every source uses, so no source can select a different
 * column set or forget the child-table pass. `where` is required — an unbounded
 * feed query is always a bug — and `orderBy`/`limit` are the caller's, because
 * the ordering axis is what distinguishes a chronological source from a ranked
 * one.
 */
export async function selectCandidatePosts(
  db: Database,
  options: { where: SQL; orderBy: SQL[]; limit: number },
): Promise<CandidatePost[]> {
  const rows = await db
    .select(candidatePostColumns)
    .from(posts)
    .where(options.where)
    .orderBy(...options.orderBy)
    .limit(options.limit);
  return loadCandidatePosts(db, rows);
}
