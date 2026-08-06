/**
 * The ONLY module that knows a post is nine tables.
 *
 * Everything above it — hydration, creation, the controllers, and (once their
 * batches land) the feed engine, the federation connectors and the MTN emitter —
 * reads and writes a whole {@link PostRecord}. That boundary is the point: the
 * normalized shape is a storage decision, and letting it leak would put an
 * eight-way join in every consumer and make the child tables impossible to
 * change without touching all of them.
 *
 * ## Three traps this module is written against, each already paid for
 *
 * 1. **A correlated predicate that silently matches nothing.** A drizzle column
 *    interpolated into `sql` renders BARE when its table is not in that
 *    statement's `FROM`, so the predicate compares two columns of the
 *    subquery's own table and returns `[]` with no error.
 *
 *    This DOES reproduce at the pinned drizzle-orm (0.45.2) — an earlier note
 *    here said otherwise, and it was measuring the wrong shapes. What is safe is
 *    a reference inside a BUILDER `.where()` or a drizzle subquery, where the
 *    outer table is part of the statement drizzle is composing. What breaks is a
 *    raw `sql` template that writes its own `FROM`: rendering
 *    ``sql`select … from user_link_metadata where ${a.userId} = ${b.id}` ``
 *    emits `where "user_id" = "id"`, both bare, and `"id"` then binds to the
 *    subquery's own table. That is what shipped in the sibling oxy-api port and
 *    read follow counts as zero on every public profile.
 *
 *    It is avoided structurally rather than by discipline: every read below is a
 *    plain `select().from().where(inArray(...))` with the correlation done in
 *    TypeScript, and the one correlated predicate (`authoredBy`) delegates to
 *    `followedAuthorsSql`, which builds its subquery through drizzle's own
 *    `exists()` — verified by rendering, not assumed.
 * 2. **A raw JS array bound into `sql` becomes a ROW constructor**, so
 *    `= any(${arr})` and `<> all(${arr})` are both wrong. Every set membership
 *    below goes through `inArray`.
 * 3. **Drizzle keys `values()`/`set()` by column PROPERTY and silently ignores
 *    an unknown key.** Every write here is built from a typed object literal
 *    whose type is the table's own `$inferInsert`, so a misspelled or stale
 *    property fails `tsc` instead of writing nothing.
 *
 * ## Ordering
 *
 * Mongo sorts missing values FIRST and Postgres sorts NULLs LAST, which silently
 * reverses a batch-bounded sweep. Nothing in this module sorts on a nullable
 * column: the child tables are ordered by their `NOT NULL` `position`, and post
 * lists are ordered by `created_at` (also `NOT NULL`). A future caller that
 * needs a nullable sort key must say `nulls first` explicitly.
 */

import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { PostType, PostVisibility } from '@mention/shared-types';
import type {
  MediaItem,
  PostAttachmentDescriptor,
  PostAuthorshipEntry,
  PostContentVariant,
  PostSourceLink,
  PostStats,
  ReplyPermission,
  StoredPostContent,
} from '@mention/shared-types';
import { followedAuthorsSql } from '../../utils/postAuthorship';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { uuidv7 } from '@oxyhq/db';
import { posts } from '../schema/posts';
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
} from '../schema/postContent';
import {
  derivesReplyIntent,
  type PostRecord,
  type PostRecordClassification,
  type PostRecordFederation,
  type PostRecordInput,
  type PostRecordTopicRef,
} from './postRecord';

type PostRow = typeof posts.$inferSelect;
type PostInsert = typeof posts.$inferInsert;
type VariantRow = typeof postContentVariants.$inferSelect;
type MediaRow = typeof postMedia.$inferSelect;
type VariantMediaRow = typeof postVariantMedia.$inferSelect;

/** The shared default every code path agrees an absent reply policy means. */
const DEFAULT_REPLY_PERMISSION: ReplyPermission[] = ['anyone'];

/**
 * The column's literal union → the shared-types ENUM the DTO is typed with.
 *
 * Written as an exhaustive record rather than a cast on purpose: `satisfies
 * Record<PostRow['type'], PostType>` makes the compiler check BOTH directions,
 * so adding a value to the schema's `POST_TYPES` tuple without deciding what it
 * means on the wire fails `tsc` here instead of silently widening the DTO. A
 * plain `as PostType` would have accepted it.
 */
const POST_TYPE_BY_COLUMN = {
  text: PostType.TEXT,
  image: PostType.IMAGE,
  video: PostType.VIDEO,
  poll: PostType.POLL,
  boost: PostType.BOOST,
  quote: PostType.QUOTE,
} as const satisfies Record<PostRow['type'], PostType>;

const POST_VISIBILITY_BY_COLUMN = {
  public: PostVisibility.PUBLIC,
  followers_only: PostVisibility.FOLLOWERS_ONLY,
  private: PostVisibility.PRIVATE,
} as const satisfies Record<PostRow['visibility'], PostVisibility>;

/**
 * Drop `undefined` keys from an object literal.
 *
 * The DTOs in `@mention/shared-types` mark absent fields OPTIONAL, and the
 * contract OMITS an absent optional rather than sending `null` — the SDK's zod
 * parse rejects a null where it expects "not there". Drizzle hands back `null`
 * for every nullable column, so the record assembly converts `null → undefined`
 * and then this removes the key entirely.
 */
function compact<T extends object>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as T;
}

/** `null` (what a nullable column reads as) → `undefined` (what a DTO omits). */
function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/**
 * A media row (shared or variant-override) as the DTO's {@link MediaItem}.
 *
 * `url`/`thumbUrl`/`posterUrl`/`fullUrl`/`hlsUrl` are deliberately absent: they
 * are RESOLVED at read time by `utils/mediaResolver.ts` and were never stored.
 */
function toMediaItem(row: MediaRow | VariantMediaRow): MediaItem {
  return compact({
    id: row.mediaId,
    type: row.type,
    alt: optional(row.alt),
    width: optional(row.width),
    height: optional(row.height),
    durationSec: optional(row.durationSec),
    sizeBytes: optional(row.sizeBytes),
    orientation: optional(row.orientation),
    aspectRatio: optional(row.aspectRatio),
    mime: optional(row.mime),
    remoteUrl: optional(row.remoteUrl),
    cachedFromFederation: optional(row.cachedFromFederation),
  });
}

/** The insert columns a {@link MediaItem} fills, shared by both media tables. */
function mediaColumns(item: MediaItem, position: number) {
  return {
    position,
    mediaId: String(item.id),
    type: item.type,
    alt: item.alt ?? null,
    width: item.width ?? null,
    height: item.height ?? null,
    durationSec: item.durationSec ?? null,
    sizeBytes: item.sizeBytes ?? null,
    orientation: item.orientation ?? null,
    aspectRatio: item.aspectRatio ?? null,
    mime: item.mime ?? null,
    remoteUrl: item.remoteUrl ?? null,
    cachedFromFederation: item.cachedFromFederation ?? null,
  };
}

/**
 * Every child row a post owns, as one read produces them.
 *
 * Keyed by POST id, except {@link variantMedia} and {@link variantAltTexts},
 * which are keyed by VARIANT id — those two tables hang off a rendition, not off
 * the post, and folding them onto the post would lose which language each
 * override belongs to. The property names say so; the types do not, which is why
 * the distinction is stated here rather than left to be inferred at the call
 * site.
 */
interface PostChildRows {
  authorships: Map<string, PostAuthorshipEntry[]>;
  variants: Map<string, VariantRow[]>;
  media: Map<string, MediaRow[]>;
  /** Keyed by `post_content_variants.id`. */
  variantMedia: Map<string, VariantMediaRow[]>;
  /** Keyed by `post_content_variants.id`. */
  variantAltTexts: Map<string, Array<{ mediaId: string; description: string }>>;
  attachments: Map<string, PostAttachmentDescriptor[]>;
  sources: Map<string, PostSourceLink[]>;
  mentions: Map<string, string[]>;
  topicRefs: Map<string, NonNullable<PostRecordClassification['topicRefs']>>;
}

/** Group rows by a foreign key, preserving the order the query returned them in. */
function groupBy<Row, Value>(
  rows: readonly Row[],
  key: (row: Row) => string,
  value: (row: Row) => Value,
): Map<string, Value[]> {
  const grouped = new Map<string, Value[]>();
  for (const row of rows) {
    const id = key(row);
    const bucket = grouped.get(id);
    if (bucket) {
      bucket.push(value(row));
    } else {
      grouped.set(id, [value(row)]);
    }
  }
  return grouped;
}

/**
 * Read every child table for a set of post ids — one query per table, never one
 * per post.
 *
 * Each is ordered by its own `position` (or, for the position-less tables, by a
 * stable key) so `variants[0]` really is the primary rendition and the media
 * gallery renders in the order the author arranged it.
 */
async function loadChildRows(
  db: DatabaseOrTransaction,
  postIds: readonly string[],
): Promise<PostChildRows> {
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
      .select()
      .from(postAuthorships)
      .where(inArray(postAuthorships.postId, [...postIds]))
      // Owner FIRST — the byline order `getHeaderAuthorshipEntries` renders and
      // the order `getOwner` finds. That half is guaranteed by the explicit rank
      // below, not by the id.
      //
      // Spelled as an explicit rank rather than `asc(role)`: alphabetically
      // 'collaborator' sorts BEFORE 'owner', so the natural ordering puts the
      // byline in the wrong order, and `desc(role)` would only be right by an
      // accident of spelling that a future role name would silently break.
      //
      // COLLABORATORS AMONG THEMSELVES ARE ARBITRARY, NOT IN INVITE ORDER, and
      // this comment used to claim otherwise. `asc(id)` cannot deliver insertion
      // order here: `uuidv7()` (`@oxyhq/db`) is a millisecond
      // timestamp plus pure randomness with NO monotonic counter, and every
      // authorship row for a post is written by ONE multi-row insert — so the
      // ids share a millisecond and their relative order is random. It is STABLE
      // per post (an id never changes), so a byline does not reshuffle between
      // reads; it simply is not the order the collaborators were invited in.
      //
      // Same rule the sibling load below writes down for topic refs: if true
      // insertion order ever matters, it needs a `position` column and a
      // migration, not a different sort. `postContentVariants` and `postSources`
      // already have one.
      .orderBy(
        sql`case ${postAuthorships.role} when 'owner' then 0 else 1 end`,
        asc(postAuthorships.id),
      ),
    db
      .select()
      .from(postContentVariants)
      .where(inArray(postContentVariants.postId, [...postIds]))
      .orderBy(asc(postContentVariants.position)),
    db
      .select()
      .from(postMedia)
      .where(inArray(postMedia.postId, [...postIds]))
      .orderBy(asc(postMedia.position)),
    db
      .select()
      .from(postAttachments)
      .where(inArray(postAttachments.postId, [...postIds]))
      .orderBy(asc(postAttachments.position)),
    db
      .select()
      .from(postSources)
      .where(inArray(postSources.postId, [...postIds]))
      .orderBy(asc(postSources.position)),
    db
      .select()
      .from(postMentions)
      .where(inArray(postMentions.postId, [...postIds]))
      .orderBy(asc(postMentions.id)),
    db
      .select()
      .from(postClassificationTopicRefs)
      .where(inArray(postClassificationTopicRefs.postId, [...postIds]))
      // Mongo's array preserved the order the classifier emitted, and the table
      // has no `position` column to reproduce it. `relevance DESC` recovers the
      // MEANING of that order wherever the classifier supplied one, with `name`
      // as a deterministic tie-break so a page never reshuffles between reads;
      // plain alphabetical (what this was) discards the ranking entirely. Every
      // reader today is set-like — membership, grouping — so this is about not
      // throwing information away rather than about a consumer that indexes
      // `[0]`. If true insertion order ever matters, it needs a `position`
      // column and a migration, not a different sort.
      .orderBy(
        sql`${postClassificationTopicRefs.relevance} desc nulls last`,
        asc(postClassificationTopicRefs.name),
      ),
  ]);

  // The variant-owned tables key on the VARIANT, so they can only be read once
  // the variant ids are known. Grouped back onto the post by that mapping.
  const variantIds = variantRows.map((row) => row.id);
  const [variantMediaRows, variantAltRows] = variantIds.length === 0
    ? [[] as VariantMediaRow[], [] as Array<typeof postVariantAltTexts.$inferSelect>]
    : await Promise.all([
      db
        .select()
        .from(postVariantMedia)
        .where(inArray(postVariantMedia.variantId, variantIds))
        .orderBy(asc(postVariantMedia.position)),
      db
        .select()
        .from(postVariantAltTexts)
        .where(inArray(postVariantAltTexts.variantId, variantIds))
        .orderBy(asc(postVariantAltTexts.mediaId)),
    ]);

  return {
    authorships: groupBy(
      authorshipRows,
      (row) => row.postId,
      (row): PostAuthorshipEntry => compact({
        oxyUserId: row.oxyUserId,
        role: row.role,
        status: row.status,
        invitedAt: row.invitedAt?.toISOString(),
        respondedAt: row.respondedAt?.toISOString(),
      }),
    ),
    variants: groupBy(variantRows, (row) => row.postId, (row) => row),
    media: groupBy(mediaRows, (row) => row.postId, (row) => row),
    variantMedia: groupBy(variantMediaRows, (row) => row.variantId, (row) => row),
    variantAltTexts: groupBy(
      variantAltRows,
      (row) => row.variantId,
      (row) => ({ mediaId: row.mediaId, description: row.description }),
    ),
    attachments: groupBy(
      attachmentRows,
      (row) => row.postId,
      (row): PostAttachmentDescriptor => compact({
        type: row.type,
        id: optional(row.attachmentId),
        mediaType: optional(row.mediaType),
      }),
    ),
    sources: groupBy(
      sourceRows,
      (row) => row.postId,
      (row): PostSourceLink => compact({ url: row.url, title: optional(row.title) }),
    ),
    mentions: groupBy(mentionRows, (row) => row.postId, (row) => row.oxyUserId),
    topicRefs: groupBy(
      topicRefRows,
      (row) => row.postId,
      (row) => compact({
        name: row.name,
        topicId: optional(row.topicId),
        relevance: optional(row.relevance),
        type: optional(row.type),
      }),
    ),
  };
}

/** Rebuild one post's `content.variants` from its variant rows. */
function assembleVariants(
  variantRows: readonly VariantRow[],
  children: PostChildRows,
): PostContentVariant[] {
  return variantRows.map((row) => {
    const overrideMedia = children.variantMedia.get(row.id);
    const altRows = children.variantAltTexts.get(row.id);
    const alt = altRows && altRows.length > 0
      ? Object.fromEntries(altRows.map((entry) => [entry.mediaId, entry.description]))
      : undefined;
    const article = row.articleTitle !== null || row.articleBody !== null || row.articleExcerpt !== null
      ? compact({
        title: optional(row.articleTitle),
        body: optional(row.articleBody),
        excerpt: optional(row.articleExcerpt),
      })
      : undefined;

    return compact<PostContentVariant>({
      tag: optional(row.tag),
      source: row.source,
      text: row.body,
      alt,
      media: overrideMedia && overrideMedia.length > 0
        ? overrideMedia.map(toMediaItem)
        : undefined,
      article,
      createdAt: row.variantCreatedAt?.toISOString(),
    });
  });
}

/** Rebuild one post's `content` from its scalar columns plus its child rows. */
function assembleContent(row: PostRow, children: PostChildRows): StoredPostContent {
  const variantRows = children.variants.get(row.id) ?? [];
  const mediaRows = children.media.get(row.id) ?? [];
  const attachments = children.attachments.get(row.id) ?? [];
  const sources = children.sources.get(row.id) ?? [];

  const article = row.contentArticleId !== null
    || row.contentArticleTitle !== null
    || row.contentArticleExcerpt !== null
    ? compact({
      articleId: optional(row.contentArticleId),
      title: optional(row.contentArticleTitle),
      excerpt: optional(row.contentArticleExcerpt),
    })
    : undefined;

  const event = row.contentEventName !== null && row.contentEventDate !== null
    ? compact({
      eventId: optional(row.contentEventId),
      name: row.contentEventName,
      date: row.contentEventDate.toISOString(),
      location: optional(row.contentEventLocation),
      description: optional(row.contentEventDescription),
    })
    : undefined;

  const room = row.contentRoomId !== null && row.contentRoomTitle !== null
    ? compact({
      roomId: row.contentRoomId,
      title: row.contentRoomTitle,
      status: optional(row.contentRoomStatus),
      topic: optional(row.contentRoomTopic),
      host: optional(row.contentRoomHost),
    })
    : undefined;

  const podcast = row.contentPodcastSyraId !== null
    && row.contentPodcastTitle !== null
    && row.contentPodcastShowUrl !== null
    ? compact({
      syraPodcastId: row.contentPodcastSyraId,
      title: row.contentPodcastTitle,
      author: optional(row.contentPodcastAuthor),
      artworkUrl: optional(row.contentPodcastArtworkUrl),
      showUrl: row.contentPodcastShowUrl,
    })
    : undefined;

  // GeoJSON, rebuilt from the NAMED coordinate columns in `[longitude, latitude]`
  // order. The generated `content_geo` point is the same fact and is never read
  // back for the DTO — one representation on the wire, one in the index.
  const location = row.contentLocationLatitude !== null && row.contentLocationLongitude !== null
    ? compact({
      type: 'Point' as const,
      coordinates: [row.contentLocationLongitude, row.contentLocationLatitude] as [number, number],
      address: optional(row.contentLocationAddress),
    })
    : undefined;

  return compact<StoredPostContent>({
    variants: variantRows.length > 0 ? assembleVariants(variantRows, children) : undefined,
    media: mediaRows.length > 0 ? mediaRows.map(toMediaItem) : undefined,
    article,
    pollId: optional(row.contentPollId),
    location,
    sources: sources.length > 0 ? sources : undefined,
    event,
    room,
    podcast,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

/** Rebuild `federation`, or `undefined` for a native post. */
function assembleFederation(row: PostRow): PostRecordFederation | undefined {
  if (
    row.federationActivityId === null
    && row.federationActorUri === null
    && row.federationInReplyTo === null
    && row.federationUrl === null
    && row.federationSensitive === null
    && row.federationSpoilerText === null
  ) {
    return undefined;
  }
  return compact<PostRecordFederation>({
    activityId: optional(row.federationActivityId),
    actorUri: optional(row.federationActorUri),
    inReplyTo: optional(row.federationInReplyTo),
    url: optional(row.federationUrl),
    sensitive: optional(row.federationSensitive),
    spoilerText: optional(row.federationSpoilerText),
  });
}

/** Turn one `posts` row plus its children into the record consumers read. */
function assembleRecord(row: PostRow, children: PostChildRows): PostRecord {
  const topicRefs = children.topicRefs.get(row.id);

  return compact<PostRecord>({
    id: row.id,
    oxyUserId: row.oxyUserId,
    authorship: children.authorships.get(row.id) ?? [],

    type: POST_TYPE_BY_COLUMN[row.type],
    visibility: POST_VISIBILITY_BY_COLUMN[row.visibility],
    status: row.status,
    isReply: row.isReply,

    hasLinks: row.hasLinks,
    isEdited: row.isEdited,
    language: optional(row.language),
    curated: optional(row.curated),
    tags: optional(row.tags),
    hashtags: row.hashtags ?? [],
    editHistory: row.editHistory ?? [],
    replyPermission: (row.replyPermission ?? DEFAULT_REPLY_PERMISSION) as ReplyPermission[],
    reviewReplies: row.reviewReplies,
    quotesDisabled: row.quotesDisabled,

    boostOf: row.boostOf,
    writtenByOxyUserId: row.writtenByOxyUserId,
    laneId: row.laneId,
    quoteOf: row.quoteOf,
    parentPostId: row.parentPostId,
    threadId: row.threadId,
    scheduledFor: row.scheduledFor,

    content: assembleContent(row, children),
    mentions: children.mentions.get(row.id) ?? [],

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

    metadata: compact({
      isSensitive: row.metadataIsSensitive,
      isPinned: row.metadataIsPinned,
      isBoosted: row.metadataIsBoosted,
      isCommented: row.metadataIsCommented,
      isFollowingAuthor: row.metadataIsFollowingAuthor,
      authorBlocked: row.metadataAuthorBlocked,
      authorMuted: row.metadataAuthorMuted,
      hideEngagementCounts: row.metadataHideEngagementCounts,
      collabFederationDeferred: row.metadataCollabFederationDeferred,
      federationDelivered: row.metadataFederationDelivered,
      // The CW label lives on the federation columns; the DTO surfaces it here
      // too because `PostMetadata` is where every renderer looks for it.
      spoilerText: optional(row.federationSpoilerText),
    }),

    federation: assembleFederation(row),

    postClassification: compact<PostRecordClassification>({
      status: row.classificationStatus,
      attempts: row.classificationAttempts,
      topics: optional(row.classificationTopics),
      topicRefs: topicRefs && topicRefs.length > 0 ? topicRefs : undefined,
      languages: optional(row.classificationLanguages),
      region: optional(row.classificationRegion),
      hashtagsNorm: optional(row.classificationHashtagsNorm),
      trendTerms: optional(row.classificationTrendTerms),
      sensitive: optional(row.classificationSensitive),
      version: optional(row.classificationVersion),
      sentiment: row.classificationSentiment,
      intent: row.classificationIntent,
      scores: {
        toxicity: row.classificationScoreToxicity,
        constructiveness: row.classificationScoreConstructiveness,
        spam: row.classificationScoreSpam,
        quality: row.classificationScoreQuality,
        controversy: row.classificationScoreControversy,
        negativity: row.classificationScoreNegativity,
      },
      confidence: row.classificationConfidence,
      classifiedAt: optional(row.classificationClassifiedAt),
    }),

    location: row.locationLatitude !== null && row.locationLongitude !== null
      ? compact({
        type: 'Point' as const,
        coordinates: [row.locationLongitude, row.locationLatitude] as [number, number],
        address: optional(row.locationAddress),
      })
      : undefined,

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * Assemble records for a set of `posts` rows the caller has already selected.
 *
 * This is the seam the FEED batch needs: a feed source runs its own ranked,
 * cursored query against `posts` and hands the rows here, so ranking stays where
 * it belongs and assembly stays here.
 */
export async function assemblePostRecords(
  rows: readonly PostRow[],
  db: DatabaseOrTransaction = getDb(),
): Promise<PostRecord[]> {
  if (rows.length === 0) return [];
  const children = await loadChildRows(db, rows.map((row) => row.id));
  return rows.map((row) => assembleRecord(row, children));
}

/**
 * Load posts by id.
 *
 * Returned in the order `postIds` asked for, skipping ids with no row — the
 * caller's own ordering is the one that matters (a feed's ranking, a graph
 * walk's discovery order), and Postgres would otherwise hand them back in
 * whatever order the index scan produced.
 */
export async function loadPostRecords(
  postIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<PostRecord[]> {
  if (postIds.length === 0) return [];
  const rows = await db.select().from(posts).where(inArray(posts.id, [...postIds]));
  const records = await assemblePostRecords(rows, db);
  const byId = new Map(records.map((record) => [record.id, record]));
  return postIds.flatMap((id) => {
    const record = byId.get(id);
    return record ? [record] : [];
  });
}

/** Load one post, or `null` when no row matches. */
export async function loadPostRecord(
  postId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PostRecord | null> {
  const [record] = await loadPostRecords([postId], db);
  return record ?? null;
}

/**
 * Flip ONE still-scheduled post to `published`, and return it only to the caller
 * that won the flip.
 *
 * This is a CLAIM, not an update: the publish pipeline behind it federates,
 * writes an MTN record and notifies, so two callers holding the same post must
 * not both run it. That is reachable in practice — the 60s sweep may load a due
 * post moments before its author taps "post now".
 *
 * `status = 'scheduled'` in the WHERE is the mutual exclusion. The UPDATE takes a
 * row lock, so a second caller blocks until the first commits and then re-checks
 * the predicate against the COMMITTED row, which no longer says `scheduled` —
 * it matches nothing and gets `null`. That is the same filter the sweep selects
 * on, so the sweep is excluded too. No advisory lock and no explicit transaction
 * are needed for this: a single UPDATE statement is already atomic.
 *
 * `ownerId` narrows the claim to one author for the request path. The sweep omits
 * it, since it publishes on nobody's behalf.
 *
 * Returns the whole record so the caller can run the pipeline without a second
 * read. `RETURNING id` then assembling is deliberate — a post is nine tables and
 * `RETURNING *` would still only give one of them.
 */
export async function claimScheduledPost(
  postId: string,
  ownerId: string | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<PostRecord | null> {
  const [claimed] = await db
    .update(posts)
    .set({ status: 'published' })
    .where(and(
      eq(posts.id, postId),
      eq(posts.status, 'scheduled'),
      ...(ownerId ? [eq(posts.oxyUserId, ownerId)] : []),
    ))
    .returning({ id: posts.id });
  if (!claimed) return null;
  return loadPostRecord(claimed.id, db);
}

/**
 * Run an arbitrary predicate over `posts` and assemble the matches.
 *
 * The ordering and the limit are the caller's, because only the caller knows
 * which keyset its cursor is on. `orderBy` is required rather than defaulted: an
 * unordered paged read is a bug that only shows up as a duplicated or skipped
 * row at a page boundary.
 */
export async function findPostRecords(
  where: SQL | undefined,
  options: { orderBy: SQL[]; limit?: number; offset?: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<PostRecord[]> {
  const base = db.select().from(posts).where(where).orderBy(...options.orderBy);
  const limited = options.limit === undefined ? base : base.limit(options.limit);
  const rows = await (options.offset === undefined ? limited : limited.offset(options.offset));
  return assemblePostRecords(rows, db);
}

/** The scalar columns of one post, derived from a {@link PostRecordInput}. */
function toPostInsert(input: PostRecordInput, id: string): PostInsert {
  const content = input.content;
  const classification = input.postClassification;
  const scores = classification?.scores;
  const metadata = input.metadata ?? {};

  return {
    id,
    oxyUserId: input.oxyUserId,
    type: input.type,
    visibility: input.visibility,
    status: input.status,
    // Derived HERE and nowhere else, from the parent links the caller passed —
    // see `derivesReplyIntent`. A caller cannot set it independently, so the
    // stored discriminator can never disagree with the links the CHECK
    // constraints police.
    isReply: derivesReplyIntent(input),
    hasLinks: input.hasLinks ?? false,
    isEdited: false,
    language: input.language ?? null,
    tags: input.tags ?? null,
    hashtags: input.hashtags ?? [],
    editHistory: [],
    replyPermission: input.replyPermission ?? DEFAULT_REPLY_PERMISSION,
    reviewReplies: input.reviewReplies ?? false,
    quotesDisabled: input.quotesDisabled ?? false,

    boostOf: input.boostOf ?? null,
    // Ordinary nullable values. Mongo had to set them ONLY when present,
    // because `post_lane_chrono_v1`'s partial filter was `{ laneId: { $exists:
    // true } }` and a stored `null` SATISFIED it — indexing the whole
    // collection and defeating the partial index. The Postgres filter is
    // `where lane_id is not null`, so NULL is exactly the state that stays out
    // of it: "absent" and "null" are one state here rather than two that can
    // disagree.
    writtenByOxyUserId: input.writtenByOxyUserId ?? null,
    laneId: input.laneId ?? null,
    quoteOf: input.quoteOf ?? null,
    parentPostId: input.parentPostId ?? null,
    threadId: input.threadId ?? null,
    scheduledFor: input.scheduledFor ?? null,

    metadataIsSensitive: metadata.isSensitive ?? false,
    metadataIsPinned: metadata.isPinned ?? false,
    metadataIsBoosted: metadata.isBoosted ?? false,
    metadataIsCommented: metadata.isCommented ?? false,
    metadataIsFollowingAuthor: metadata.isFollowingAuthor ?? false,
    metadataAuthorBlocked: metadata.authorBlocked ?? false,
    metadataAuthorMuted: metadata.authorMuted ?? false,
    metadataHideEngagementCounts: metadata.hideEngagementCounts ?? false,
    metadataCollabFederationDeferred: metadata.collabFederationDeferred ?? false,
    metadataFederationDelivered: metadata.federationDelivered ?? false,

    federationActivityId: input.federation?.activityId ?? null,
    federationActorUri: input.federation?.actorUri ?? null,
    federationInReplyTo: input.federation?.inReplyTo ?? null,
    federationUrl: input.federation?.url ?? null,
    federationSensitive: input.federation?.sensitive ?? null,
    federationSpoilerText: input.federation?.spoilerText ?? null,

    contentPollId: content.pollId ?? null,
    contentArticleId: content.article?.articleId ?? null,
    contentArticleTitle: content.article?.title ?? null,
    contentArticleExcerpt: content.article?.excerpt ?? null,

    contentEventId: content.event?.eventId ?? null,
    contentEventName: content.event?.name ?? null,
    contentEventDate: content.event?.date ? new Date(content.event.date) : null,
    contentEventLocation: content.event?.location ?? null,
    contentEventDescription: content.event?.description ?? null,

    contentRoomId: content.room?.roomId ?? null,
    contentRoomTitle: content.room?.title ?? null,
    contentRoomStatus: content.room?.status ?? null,
    contentRoomTopic: content.room?.topic ?? null,
    contentRoomHost: content.room?.host ?? null,

    contentPodcastSyraId: content.podcast?.syraPodcastId ?? null,
    contentPodcastTitle: content.podcast?.title ?? null,
    contentPodcastAuthor: content.podcast?.author ?? null,
    contentPodcastArtworkUrl: content.podcast?.artworkUrl ?? null,
    contentPodcastShowUrl: content.podcast?.showUrl ?? null,

    // `[longitude, latitude]`, stated once. The generated geography point reads
    // these two columns, so a transposition here is a wrong point rather than a
    // constraint violation — which is exactly why the ORDER is spelled out at
    // the one place that writes them.
    contentLocationLongitude: content.location?.coordinates[0] ?? null,
    contentLocationLatitude: content.location?.coordinates[1] ?? null,
    contentLocationAddress: content.location?.address ?? null,

    locationLongitude: input.location?.coordinates[0] ?? null,
    locationLatitude: input.location?.coordinates[1] ?? null,
    locationAddress: input.location?.address ?? null,

    classificationTopics: classification?.topics ?? null,
    classificationLanguages: classification?.languages ?? null,
    classificationRegion: classification?.region ?? null,
    classificationHashtagsNorm: classification?.hashtagsNorm ?? null,
    classificationTrendTerms: classification?.trendTerms ?? null,
    classificationSensitive: classification?.sensitive ?? null,
    classificationVersion: classification?.version ?? null,
    classificationSentiment: classification?.sentiment ?? 'neutral',
    classificationIntent: classification?.intent ?? 'other',
    classificationScoreToxicity: scores?.toxicity ?? 0,
    classificationScoreConstructiveness: scores?.constructiveness ?? 0,
    classificationScoreSpam: scores?.spam ?? 0,
    classificationScoreQuality: scores?.quality ?? 0,
    classificationScoreControversy: scores?.controversy ?? 0,
    classificationScoreNegativity: scores?.negativity ?? 0,
    classificationConfidence: classification?.confidence ?? 0,
    classificationStatus: classification?.status ?? 'pending',
    classificationAttempts: classification?.attempts ?? 0,
    classificationClassifiedAt: classification?.classifiedAt ?? null,

    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

/**
 * `post_authorships.post_created_at` READ BACK FROM THE POST, in the statement
 * that writes the row.
 *
 * A denormalized copy is only as good as the thing that writes it, and the
 * obvious spelling — thread the `Date` in as a parameter — makes "the copy
 * disagrees with `posts.created_at`" a thing a caller can do by passing the
 * wrong value, silently, with the index then ordering a profile by a timestamp
 * that post never had. Deriving it from the authority in the same `INSERT`
 * removes the parameter, so there is nothing to pass wrongly: the row is written
 * from the post or it is not written at all.
 *
 * Safe in both writers because the `posts` row is already visible to the
 * transaction — `insertPostRecord` inserts it immediately before calling
 * {@link insertChildRows}, and `replacePostAuthorship` only ever runs against a
 * post that already exists. A subquery on the primary key costs a single index
 * lookup per statement.
 */
function postCreatedAtSql(postId: string): SQL<Date> {
  return sql<Date>`(select ${posts.createdAt} from ${posts} where ${posts.id} = ${postId})`;
}

/**
 * Write every child row a post owns.
 *
 * Shared by insert and by the content-replacing half of {@link updatePostContent}
 * so the two can never write a differently-shaped child set — the failure mode
 * being an edit that silently drops a variant's localized alt text because only
 * one of the two paths knew about that table.
 */
async function insertChildRows(
  tx: DatabaseOrTransaction,
  postId: string,
  content: StoredPostContent,
  authorship: readonly PostAuthorshipEntry[],
  mentions: readonly string[],
  topicRefs: PostRecordClassification['topicRefs'],
): Promise<void> {
  if (authorship.length > 0) {
    await tx.insert(postAuthorships).values(
      authorship.map((entry) => ({
        postId,
        oxyUserId: entry.oxyUserId,
        role: entry.role,
        status: entry.status,
        invitedAt: entry.invitedAt ? new Date(entry.invitedAt) : null,
        respondedAt: entry.respondedAt ? new Date(entry.respondedAt) : null,
        postCreatedAt: postCreatedAtSql(postId),
      })),
    );
  }

  const variants = content.variants ?? [];
  if (variants.length > 0) {
    const variantIds = variants.map(() => uuidv7());
    await tx.insert(postContentVariants).values(
      variants.map((variant, position) => ({
        id: variantIds[position],
        postId,
        position,
        tag: variant.tag ?? null,
        source: variant.source,
        body: variant.text,
        articleTitle: variant.article?.title ?? null,
        articleBody: variant.article?.body ?? null,
        articleExcerpt: variant.article?.excerpt ?? null,
        variantCreatedAt: variant.createdAt ? new Date(variant.createdAt) : null,
      })),
    );

    const overrideRows = variants.flatMap((variant, index) =>
      (variant.media ?? []).map((item, position) => ({
        variantId: variantIds[index],
        ...mediaColumns(item, position),
      })),
    );
    if (overrideRows.length > 0) {
      await tx.insert(postVariantMedia).values(overrideRows);
    }

    const altRows = variants.flatMap((variant, index) =>
      Object.entries(variant.alt ?? {}).map(([mediaId, description]) => ({
        variantId: variantIds[index],
        mediaId,
        description,
      })),
    );
    if (altRows.length > 0) {
      await tx.insert(postVariantAltTexts).values(altRows);
    }
  }

  const media = content.media ?? [];
  if (media.length > 0) {
    await tx.insert(postMedia).values(
      media.map((item, position) => ({ postId, ...mediaColumns(item, position) })),
    );
  }

  const attachments = content.attachments ?? [];
  if (attachments.length > 0) {
    await tx.insert(postAttachments).values(
      attachments.map((attachment, position) => ({
        postId,
        position,
        type: attachment.type,
        attachmentId: attachment.id ?? null,
        mediaType: attachment.mediaType ?? null,
      })),
    );
  }

  const sources = content.sources ?? [];
  if (sources.length > 0) {
    await tx.insert(postSources).values(
      sources.map((source, position) => ({
        postId,
        position,
        url: source.url,
        title: source.title ?? null,
      })),
    );
  }

  // Deduped: `post_mentions` is unique on `(post_id, oxy_user_id)`, and a caller
  // that reconciled its allowlist from free text can legitimately produce the
  // same id twice.
  const uniqueMentions = [...new Set(mentions)];
  if (uniqueMentions.length > 0) {
    await tx.insert(postMentions).values(
      uniqueMentions.map((oxyUserId) => ({ postId, oxyUserId })),
    );
  }

  if (topicRefs && topicRefs.length > 0) {
    await tx.insert(postClassificationTopicRefs).values(
      topicRefs.map((ref) => ({
        postId,
        name: ref.name,
        topicId: ref.topicId ?? null,
        relevance: ref.relevance ?? null,
        type: ref.type ?? null,
      })),
    );
  }
}

/**
 * Persist a new post and every row it owns, atomically.
 *
 * ONE transaction, deliberately: a post whose authorship row failed to land has
 * no owner, and `post_authorships` is the AUTHORITY that `posts.oxy_user_id`
 * merely projects — so a partially-written post is not a degraded post, it is an
 * unattributable one that no feed query can find and no ACL can evaluate.
 */
export async function insertPostRecord(
  input: PostRecordInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<PostRecord> {
  const id = input.id ?? uuidv7();

  const write = async (tx: DatabaseOrTransaction): Promise<void> => {
    await tx.insert(posts).values(toPostInsert(input, id));
    await insertChildRows(
      tx,
      id,
      input.content,
      input.authorship,
      input.mentions ?? [],
      input.postClassification?.topicRefs,
    );
  };

  // A caller already inside a transaction passes its handle; a `Transaction` has
  // no `.transaction`, so the nesting is decided by the type rather than by a
  // runtime probe.
  if ('transaction' in db) {
    await db.transaction(write);
  } else {
    await write(db);
  }

  const record = await loadPostRecord(id, db);
  if (!record) {
    // Unreachable via the transaction above; a throw is still correct because a
    // caller that got an id back and no row would otherwise proceed as if the
    // post existed.
    throw new Error(`insertPostRecord: post ${id} was not readable after insert`);
  }
  return record;
}

/** Fields a caller may change on an existing post's scalar row. */
export interface PostRecordPatch {
  status?: PostRecord['status'];
  visibility?: PostRecord['visibility'];
  language?: string | null;
  hashtags?: string[];
  tags?: string[] | null;
  isEdited?: boolean;
  editHistory?: string[];
  threadId?: string | null;
  scheduledFor?: Date | null;
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  metadata?: Partial<PostRecord['metadata']>;
  postClassification?: Partial<PostRecordClassification>;
  location?: PostRecord['location'] | null;
}

/**
 * Update a post's scalar columns.
 *
 * `metadata` and `postClassification` are MERGED key by key rather than
 * replaced, because they arrive as partials: a caller flipping
 * `federationDelivered` must not clear `isPinned`. The Mongo counterpart of this
 * was a dotted `$set`, and the trap it carried is the reason this is explicit —
 * a Mongo dot path handed to drizzle's `set()` is an unknown property that
 * drizzle silently IGNORES, so the write does nothing and throws nothing.
 */
export async function updatePostRecord(
  postId: string,
  patch: PostRecordPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const metadata = patch.metadata;
  const classification = patch.postClassification;
  const scores = classification?.scores;

  const values: Partial<PostInsert> = compact({
    status: patch.status,
    visibility: patch.visibility,
    language: patch.language,
    hashtags: patch.hashtags,
    tags: patch.tags,
    isEdited: patch.isEdited,
    editHistory: patch.editHistory,
    threadId: patch.threadId,
    scheduledFor: patch.scheduledFor,
    replyPermission: patch.replyPermission,
    reviewReplies: patch.reviewReplies,
    quotesDisabled: patch.quotesDisabled,

    metadataIsSensitive: metadata?.isSensitive,
    metadataIsPinned: metadata?.isPinned,
    metadataIsBoosted: metadata?.isBoosted,
    metadataIsCommented: metadata?.isCommented,
    metadataIsFollowingAuthor: metadata?.isFollowingAuthor,
    metadataAuthorBlocked: metadata?.authorBlocked,
    metadataAuthorMuted: metadata?.authorMuted,
    metadataHideEngagementCounts: metadata?.hideEngagementCounts,
    metadataCollabFederationDeferred: metadata?.collabFederationDeferred,
    metadataFederationDelivered: metadata?.federationDelivered,

    classificationTopics: classification?.topics,
    classificationLanguages: classification?.languages,
    classificationRegion: classification?.region,
    classificationHashtagsNorm: classification?.hashtagsNorm,
    classificationTrendTerms: classification?.trendTerms,
    classificationSensitive: classification?.sensitive,
    classificationVersion: classification?.version,
    classificationSentiment: classification?.sentiment,
    classificationIntent: classification?.intent,
    classificationScoreToxicity: scores?.toxicity,
    classificationScoreConstructiveness: scores?.constructiveness,
    classificationScoreSpam: scores?.spam,
    classificationScoreQuality: scores?.quality,
    classificationScoreControversy: scores?.controversy,
    classificationScoreNegativity: scores?.negativity,
    classificationConfidence: classification?.confidence,
    classificationStatus: classification?.status,
    classificationAttempts: classification?.attempts,
    classificationClassifiedAt: classification?.classifiedAt,

    ...(patch.location === undefined
      ? {}
      : patch.location === null
        ? { locationLongitude: null, locationLatitude: null, locationAddress: null }
        : {
          locationLongitude: patch.location.coordinates[0],
          locationLatitude: patch.location.coordinates[1],
          locationAddress: patch.location.address ?? null,
        }),
  });

  // The child table is written FIRST and unconditionally on presence, because
  // the scalar early-return below must not be able to skip it: a patch carrying
  // only `topicRefs` produces no column values at all.
  if (classification?.topicRefs !== undefined) {
    await replaceTopicRefs(postId, classification.topicRefs, db);
  }

  if (Object.keys(values).length === 0) return;
  await db.update(posts).set(values).where(eq(posts.id, postId));
}

/**
 * Replace a post's classification topic refs wholesale.
 *
 * Delete-then-insert in ONE transaction, the same shape as
 * {@link replacePostAuthorship}, because an enrichment pass REPLACES the topic
 * set rather than adding to it: a topic the classifier dropped has to disappear,
 * and the `(post_id, name)` unique index would reject a plain re-insert anyway.
 *
 * This exists because `updatePostRecord` maps scalar COLUMNS, and `topicRefs` is
 * a child table. It type-checked as part of `PostRecordPatch.postClassification`
 * and was silently ignored — so Stage-B AI enrichment, the only producer of
 * registry-linked refs, wrote its topics to the scalar `classification_topics`
 * array and dropped every `topicId` linkage on the floor. Nothing errored;
 * trending, the topic pages and personalization just stopped seeing AI topics.
 */
export async function replaceTopicRefs(
  postId: string,
  topicRefs: readonly PostRecordTopicRef[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const write = async (tx: DatabaseOrTransaction): Promise<void> => {
    await tx
      .delete(postClassificationTopicRefs)
      .where(eq(postClassificationTopicRefs.postId, postId));
    if (topicRefs.length > 0) {
      await tx.insert(postClassificationTopicRefs).values(
        topicRefs.map((ref) => ({
          postId,
          name: ref.name,
          topicId: ref.topicId ?? null,
          relevance: ref.relevance ?? null,
          type: ref.type ?? null,
        })),
      );
    }
  };

  if ('transaction' in db) {
    await db.transaction(write);
    return;
  }
  await write(db);
}

/**
 * The denormalized counters a caller outside `PostEngagementCommandService` moves.
 *
 * Likes, downvotes and saves are deliberately ABSENT: those three are maintained
 * transactionally with the `likes`/`bookmarks` rows they project, and a second
 * door onto them is how a projection starts disagreeing with its authority.
 * These four have no relationship table of their own — a reply, a boost and a
 * view are counted where they happen.
 */
export interface PostCounterDelta {
  comments?: number;
  boosts?: number;
  /** Of {@link boosts}, the subset that arrived as an inbound AP Announce. */
  federatedBoosts?: number;
  views?: number;
}

/**
 * Apply counter deltas to a post and return the counters as they now stand, or
 * `null` when no row matched.
 *
 * One statement — the increment, the clamp and the read-back are the same
 * `UPDATE … RETURNING`, so no window exists in which a response could report a
 * value another transaction has already moved.
 *
 * The `greatest(0, …)` clamp is a DELIBERATE difference from the Mongo `$inc` it
 * replaces, and matches what `PostEngagementCommandService` already chose: a
 * double unboost drove `stats.boostsCount` negative in Mongo, and a negative
 * count is both nonsense on the wire and a ranking input that pushes a post below
 * every post with no engagement at all.
 *
 * The AUTHOR comes back with the counters, on the same round trip, because the
 * realtime broadcast needs both: whose privacy settings decide what may be sent,
 * and what the numbers now are. Reading the author separately would be a second
 * query that could answer about a different version of the row.
 */
export async function bumpPostCounters(
  postId: string,
  delta: PostCounterDelta,
  db: DatabaseOrTransaction = getDb(),
): Promise<(PostStats & { oxyUserId: string | null }) | null> {
  // `PgUpdateSetSource`, not `Partial<PostInsert>`: each value here is a SQL
  // EXPRESSION (`greatest(0, col + n)`) rather than a literal, which the insert
  // type's `number` columns reject.
  const values: PgUpdateSetSource<typeof posts> = {
    ...(delta.comments
      ? { statsCommentsCount: sql`greatest(0, ${posts.statsCommentsCount} + ${delta.comments})` }
      : {}),
    ...(delta.boosts
      ? { statsBoostsCount: sql`greatest(0, ${posts.statsBoostsCount} + ${delta.boosts})` }
      : {}),
    ...(delta.federatedBoosts
      ? {
        statsFederatedBoostsCount: sql`greatest(0, ${posts.statsFederatedBoostsCount} + ${delta.federatedBoosts})`,
      }
      : {}),
    ...(delta.views
      ? { statsViewsCount: sql`greatest(0, ${posts.statsViewsCount} + ${delta.views})` }
      : {}),
  };
  if (Object.keys(values).length === 0) return null;

  const [row] = await db
    .update(posts)
    .set(values)
    .where(eq(posts.id, postId))
    .returning({
      oxyUserId: posts.oxyUserId,
      likesCount: posts.statsLikesCount,
      downvotesCount: posts.statsDownvotesCount,
      boostsCount: posts.statsBoostsCount,
      federatedBoostsCount: posts.statsFederatedBoostsCount,
      commentsCount: posts.statsCommentsCount,
      viewsCount: posts.statsViewsCount,
      sharesCount: posts.statsSharesCount,
      savesCount: posts.statsSavesCount,
    });
  return row ?? null;
}

/**
 * Replace a post's whole content graph — the edit path.
 *
 * Delete-then-insert rather than a per-row diff, because the child tables carry
 * a dense `position` with a `UNIQUE (post_id, position)` on it: any reordering
 * edit collides with itself mid-update unless the old rows are gone first. The
 * whole thing runs in one transaction, so a reader never observes a post with
 * half its renditions.
 */
export async function replacePostContent(
  postId: string,
  content: StoredPostContent,
  mentions: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const write = async (tx: DatabaseOrTransaction): Promise<void> => {
    const variantIds = await tx
      .select({ id: postContentVariants.id })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, postId));

    if (variantIds.length > 0) {
      const ids = variantIds.map((row) => row.id);
      await tx.delete(postVariantMedia).where(inArray(postVariantMedia.variantId, ids));
      await tx.delete(postVariantAltTexts).where(inArray(postVariantAltTexts.variantId, ids));
    }
    await tx.delete(postContentVariants).where(eq(postContentVariants.postId, postId));
    await tx.delete(postMedia).where(eq(postMedia.postId, postId));
    await tx.delete(postAttachments).where(eq(postAttachments.postId, postId));
    await tx.delete(postSources).where(eq(postSources.postId, postId));
    await tx.delete(postMentions).where(eq(postMentions.postId, postId));

    await tx
      .update(posts)
      .set({
        contentPollId: content.pollId ?? null,
        contentArticleId: content.article?.articleId ?? null,
        contentArticleTitle: content.article?.title ?? null,
        contentArticleExcerpt: content.article?.excerpt ?? null,
        contentEventId: content.event?.eventId ?? null,
        contentEventName: content.event?.name ?? null,
        contentEventDate: content.event?.date ? new Date(content.event.date) : null,
        contentEventLocation: content.event?.location ?? null,
        contentEventDescription: content.event?.description ?? null,
        contentRoomId: content.room?.roomId ?? null,
        contentRoomTitle: content.room?.title ?? null,
        contentRoomStatus: content.room?.status ?? null,
        contentRoomTopic: content.room?.topic ?? null,
        contentRoomHost: content.room?.host ?? null,
        contentPodcastSyraId: content.podcast?.syraPodcastId ?? null,
        contentPodcastTitle: content.podcast?.title ?? null,
        contentPodcastAuthor: content.podcast?.author ?? null,
        contentPodcastArtworkUrl: content.podcast?.artworkUrl ?? null,
        contentPodcastShowUrl: content.podcast?.showUrl ?? null,
        contentLocationLongitude: content.location?.coordinates[0] ?? null,
        contentLocationLatitude: content.location?.coordinates[1] ?? null,
        contentLocationAddress: content.location?.address ?? null,
      })
      .where(eq(posts.id, postId));

    // Authorship and topic refs are NOT part of the content graph and are left
    // alone: an edit must never revoke a collaborator's entry.
    await insertChildRows(tx, postId, content, [], mentions, undefined);
  };

  if ('transaction' in db) {
    await db.transaction(write);
  } else {
    await write(db);
  }
}

/**
 * Replace a post's authorship list.
 *
 * The whole list, because the partial unique index allows exactly one `owner`
 * per post: adding a row while an old one still claims the role fails, so the
 * only safe shape is delete-then-insert inside one transaction.
 */
export async function replacePostAuthorship(
  postId: string,
  authorship: readonly PostAuthorshipEntry[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const write = async (tx: DatabaseOrTransaction): Promise<void> => {
    await tx.delete(postAuthorships).where(eq(postAuthorships.postId, postId));
    if (authorship.length > 0) {
      await tx.insert(postAuthorships).values(
        authorship.map((entry) => ({
          postId,
          oxyUserId: entry.oxyUserId,
          role: entry.role,
          status: entry.status,
          invitedAt: entry.invitedAt ? new Date(entry.invitedAt) : null,
          respondedAt: entry.respondedAt ? new Date(entry.respondedAt) : null,
          postCreatedAt: postCreatedAtSql(postId),
        })),
      );
    }
    // Keep the denormalized projection in step with its authority. Mongoose did
    // this in a `pre('save')` hook, which a bulk write bypassed; here it is part
    // of the same transaction as the rows it projects.
    const owner = authorship.find((entry) => entry.role === 'owner');
    await tx
      .update(posts)
      .set({ oxyUserId: owner?.oxyUserId ?? null })
      .where(eq(posts.id, postId));
  };

  if ('transaction' in db) {
    await db.transaction(write);
  } else {
    await write(db);
  }
}

/**
 * Delete a post and return the record it was, or `null` when nothing matched.
 *
 * The record is read BEFORE the delete because every caller needs it afterwards:
 * the MTN tombstone needs the author, the outbound `Delete(Tombstone)` needs the
 * id and visibility, and the cascade cleanup needs the poll and article ids.
 * Child rows go with it by `ON DELETE CASCADE`; `boostOf` cascades (a boost with
 * no original renders nothing), while `quoteOf`, `threadId` and `parentPostId`
 * are set null so posts with bodies of their own survive.
 */
export async function deletePostRecord(
  postId: string,
  where: SQL | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<PostRecord | null> {
  const record = await loadPostRecord(postId, db);
  if (!record) return null;

  const deleted = await db
    .delete(posts)
    .where(where === undefined ? eq(posts.id, postId) : and(eq(posts.id, postId), where))
    .returning({ id: posts.id });

  return deleted.length > 0 ? record : null;
}

/**
 * Posts-that-quote counts for a set of ids, in ONE grouped aggregate.
 *
 * `inArray`, never `= any(${ids})`: a raw JS array binds as a ROW constructor
 * and Postgres raises `op ANY/ALL (array) requires array on right side`.
 */
export async function countQuotesOf(
  postIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (postIds.length === 0) return counts;

  const rows = await db
    .select({ quoteOf: posts.quoteOf, count: sql<number>`count(*)::int` })
    .from(posts)
    .where(inArray(posts.quoteOf, [...postIds]))
    .groupBy(posts.quoteOf);

  for (const row of rows) {
    if (row.quoteOf) counts.set(row.quoteOf, row.count);
  }
  return counts;
}

/**
 * The ids, among `postIds`, that `viewerId` has boosted.
 *
 * A boost is a `type:'boost'` post owned by the booster, so "did I boost this?"
 * is a query over `posts` itself rather than a join table.
 */
export async function findBoostedPostIds(
  viewerId: string,
  postIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  const boosted = new Set<string>();
  if (postIds.length === 0) return boosted;

  const rows = await db
    .select({ boostOf: posts.boostOf })
    .from(posts)
    .where(and(eq(posts.oxyUserId, viewerId), inArray(posts.boostOf, [...postIds])));

  for (const row of rows) {
    if (row.boostOf) boosted.add(row.boostOf);
  }
  return boosted;
}

/**
 * Posts authored by `oxyUserId` — the `post_authorships` join that replaces the
 * Mongo `$elemMatch`.
 *
 * A collaborator sees their accepted collaborations on their own profile, which
 * is why this is an authorship join and not `posts.oxy_user_id = $1`. Returns a
 * predicate rather than rows so a caller can compose it with its own cursor and
 * ordering.
 */
export function authoredBy(oxyUserId: string): SQL {
  // ONE implementation, in `utils/postAuthorship.ts`. This function and
  // `followedAuthorsSql` were written independently by two batches for the same
  // predicate — the feed needs the N-author form, the repository needed the
  // single-author form — and two spellings of an `$elemMatch` port is precisely
  // the shape that drifts: one of them gains the `status = 'accepted'` guard and
  // the other does not, and a PENDING collaborator invite leaks onto a profile.
  //
  // A note on the qualification argument the deleted body carried: it claimed
  // the bare-column trap "does NOT reproduce at drizzle-orm 0.45.2". That is
  // true for the three shapes it measured, but NOT for the shape the schema
  // conventions actually warn about — a raw `sql` template whose subquery names
  // its own `FROM`, where both identifiers render bare. `followedAuthorsSql`
  // sidesteps the question entirely by building the subquery through drizzle's
  // own `exists()`, which qualifies unconditionally; that is verified by
  // rendering, not assumed.
  return followedAuthorsSql([oxyUserId]);
}

/**
 * Descending chronological keyset — the sort every post list in this app uses.
 *
 * `nulls last` is spelled out for the reason {@link chronoOrderBy} documents at
 * length: both columns are NOT NULL so it changes no result, but drizzle emits
 * `.desc()` in index DDL as `DESC NULLS LAST` while a query's `desc()` means
 * `DESC NULLS FIRST`, and Postgres compares the NULLS placement when deciding
 * whether an index can satisfy an ORDER BY. Written the plain way, none of the
 * thirteen chronological indexes on `posts` is usable and the planner falls back
 * to scanning the match set and sorting it.
 */
export const CHRONO_DESC: SQL[] = [
  sql`${posts.createdAt} desc nulls last`,
  sql`${posts.id} desc nulls last`,
];

/**
 * No ordering, because the predicate can match at most one row.
 *
 * {@link findPostRecords} requires `orderBy` on purpose — an unordered paged
 * read is a bug that surfaces only as a duplicated or skipped row at a page
 * boundary — and that requirement should not be relaxed to accommodate the
 * handful of reads where it genuinely has nothing to decide. Those reads say so
 * HERE instead, by name.
 *
 * Only correct behind a filter the database guarantees is unique: today that is
 * `federation_activity_id`, which carries the partial unique index
 * `posts_federation_activity_id_key`. Reaching for this because a query "should"
 * only match one row reintroduces exactly the bug the required parameter exists
 * to prevent — if the uniqueness is not a constraint, order the read.
 */
export const UNIQUE_MATCH_NO_ORDER: SQL[] = [];
