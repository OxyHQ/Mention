/**
 * MTN PostMaterializer — projects a VERIFIED signed `app.mention.feed.*` record
 * into the feed-readable store (the same `posts` / `Like` / `Bookmark` rows the
 * hot read path already reads).
 *
 * This is the READ-side dual of the write emitter (`MentionRecordEmitter`): the
 * emitter turns a native write into a signed record; the materializer turns a
 * signed record back into the native rows. The two together let the chain become
 * the source of truth in a later phase (B3+) — but in B2 the materializer is NOT
 * wired into the live create/like/boost path. It is invoked only by the B2
 * backfill and node ingest.
 *
 * CONTRACT:
 *  - IDEMPOTENT — every projection is keyed by the envelope's `rkey` (the post's
 *    `_id`), so re-projecting the same record converges to the same row (no
 *    duplicates, stable classification). Re-runs are safe.
 *  - OWNER-SCOPED — an `rkey` is a key in the SUBJECT's namespace, never a global
 *    one, so every post/boost upsert is confined to `{ id: rkey, oxy_user_id }`.
 *    A record whose rkey names ANOTHER user's post fails closed
 *    (`record_owner_mismatch`) instead of rewriting that user's row: without this
 *    a genuinely-signed record could take over any post whose id its author knows.
 *  - ZERO-REGRESSION — the post upsert writes only the fields the record OWNS
 *    (body, reply, tags, langs, sources, location, …). It NEVER replaces the whole
 *    row, and it only replaces `post_media` when the embed RESOLVES to ≥1
 *    renderable item (see below), so re-projecting an existing post whose media
 *    would not re-resolve KEEPS that media untouched. The authoritative native
 *    write path is unchanged; media rendering stays byte-identical (URLs are
 *    resolved by the existing `mediaResolver` at hydration time, exactly as for
 *    native fileId media).
 *  - READ-SIDE BLOB RESOLUTION — `record.embed` carries content-addressed blob
 *    refs (the WRITE side populates `embed[].blob.sha256` via the service SDK).
 *    The READ side turns each bare `sha256` back into a servable native MediaItem
 *    with the REVERSE content-address lookup `getServiceAssetMetadataBySha256`
 *    (core 5.2.0, `POST /assets/service/by-sha256`) — the inverse of the FORWARD
 *    `fileId → sha256` lookup the write side uses. {@link resolveRecordFileIds}
 *    maps each resolvable blob to `{ id: <resolved Oxy fileId>, type, alt? }`, so
 *    the materialized post's media renders through the EXISTING
 *    `getFileDownloadUrl` CDN path EXACTLY like a normal fileId post. FAIL-SOFT: a
 *    `sha256` with no live asset in our S3 is dropped (the upstream omits
 *    unknown/trashed hashes), so a record whose blobs are not yet mirrored yields
 *    fewer/zero items and never a fake URL.
 *  - NEVER THROWS — any failure (bad subject DID, invalid inner record, DB error)
 *    is wrapped and returned as `{ ok: false, reason }` so the backfill/ingest
 *    caller can log and continue. Validation runs FIRST: the inner `record` is
 *    parsed with the matching `mention*RecordSchema` before any projection.
 *
 * ## What the Postgres port changed, and why
 *
 * **A post is now SIX tables, and the child rows are not optional.** The body
 * lives in `post_content_variants`, the media in `post_media`, the authorship in
 * `post_authorships`, the sources in `post_sources`. Writing the parent row alone
 * produces a post that exists, passes every foreign key, satisfies every feed
 * query — and renders as an empty card, with no error anywhere. Every write below
 * happens in ONE transaction for that reason: a partially materialized post is
 * worse than an absent one, because the ingest is idempotent and would skip it.
 *
 * **The owner scope is now the upsert's own predicate.** Mongo relied on the
 * `_id` unique index to reject an upsert that missed the owner filter, and read
 * the duplicate-key error as "someone else owns this rkey". Postgres states it
 * directly: `ON CONFLICT (id) DO UPDATE … WHERE posts.oxy_user_id = $owner`
 * updates nothing when the row belongs to another account, and the empty
 * `RETURNING` is the mismatch.
 *
 * **A reply whose parent is not here yet links to nothing rather than to a
 * dangling id.** `posts.parent_post_id` / `thread_id` are real foreign keys, so
 * the Mongo behaviour (store the id, let it resolve later if the parent ever
 * arrives) is not representable. The ids are resolved against real rows first and
 * dropped when absent; a later re-projection links the reply once its parent
 * lands. See the migration report — the same escalation as `ON DELETE SET NULL`.
 *
 * **The `ObjectId.isValid` guards on like/bookmark/tombstone subjects are gone.**
 * They existed to dodge a Mongoose `CastError` and answered `invalid_*_post_id`
 * for anything that was not 24-char hex — which is every id minted after the
 * cutover. A `text` id that names no row already produces the "no such thing"
 * answer the caller was written for.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import {
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
  MENTION_BOOKMARK_COLLECTION,
  mentionPostRecordSchema,
  mentionLikeRecordSchema,
  mentionRepostRecordSchema,
  mentionTombstoneRecordSchema,
  mentionBookmarkRecordSchema,
  MtnUri,
  canonicalizeLanguageTag,
  toBaseLanguage,
  type MentionPostRecord,
  type MentionLikeRecord,
  type MentionRepostRecord,
  type MentionTombstoneRecord,
  type MentionBookmarkRecord,
  type MtnMediaEmbed,
  type MediaItem,
  type PostContentVariant,
} from '@mention/shared-types';
import { PostType, PostVisibility } from '@mention/shared-types';
import { getDb, type Transaction } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { posts } from '../../db/schema/posts';
import {
  postAuthorships,
  postContentVariants,
  postMedia,
  postSources,
  postVariantAltTexts,
  postVariantMedia,
} from '../../db/schema/postContent';
import { POST_CLASSIFICATION_PENDING } from '../../models/Post';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { parseUserDid } from './mentionDid';
import { baselineContentClassifier } from '../BaselineContentClassifier';
import { buildAuthorship } from '../../utils/postAuthorship';
import { clampFutureDate } from '../../utils/ingestTimestamp';
import {
  recordRecentReplierForPost,
  repairRecentRepliersAfterPostDelete,
} from '../PostRecentReplierService';
import {
  materializeEngagementRelationship,
  materializeEngagementTombstone,
} from '../PostEngagementCommandService';

/** The kind of native row a successful projection produced/removed. */
export type ProjectedKind = 'post' | 'like' | 'repost' | 'tombstone' | 'bookmark';

/**
 * The outcome of {@link projectRecord}. Discriminates a successful projection
 * (with the affected row id) from a no-op/failure (with a machine-readable
 * reason). NEVER an exception — the caller logs `reason` and continues.
 */
export type ProjectResult =
  | { ok: true; kind: ProjectedKind; id: string }
  | { ok: false; reason: string };

/**
 * How far ahead of our clock a record's self-asserted `createdAt` may be.
 *
 * TIGHTER than the 24h ActivityPub window and matching the atproto one, because the
 * two are answering different questions. AP's tolerance exists to accommodate a
 * THIRD-PARTY instance whose clock we cannot audit and whose real posts we must not
 * misdate — wide tolerance is the price of interop. An MTN record arrives from a node
 * the AUTHOR runs, carrying a timestamp the author's own software asserts: the
 * signature proves who wrote the record, not that its clock is honest, so the value is
 * entirely author-chosen at no cost. The only legitimate skew is that one machine
 * being off (a home server with no NTP, a VM resumed from suspend), which an hour
 * covers generously. Rejecting also costs little here — we fall back to now, and a
 * record we just synced was almost certainly authored moments ago.
 *
 * A third distinct number would be a coin flip, so this reuses the existing precedent
 * for a directly author-asserted record rather than inventing one.
 */
const MTN_RECORD_MAX_FUTURE_SKEW_MS = 60 * 60 * 1000; // 1 hour

/**
 * The creation date to materialize a record under: its own `createdAt` when that is a
 * usable timestamp, else NOW.
 *
 * Two things make the guard necessary, and the lexicon is why. `createdAt` is typed
 * `z.string().min(1)` — ANY non-empty string validates — so the raw value reaches us
 * both (a) arbitrarily far in the future, which pins the post atop the profile feed
 * and post search (both sort `{createdAt: -1, _id: -1}`) until the clock catches up,
 * and (b) entirely unparseable, where `new Date('banana').toISOString()` throws a
 * `RangeError` deep inside variant building and fails the whole projection for that
 * author.
 *
 * Falling back to `now` mirrors what the ActivityPub path gets from the schema
 * default: REJECT the value rather than re-date it to the clamp edge, since a post
 * pinned at exactly `now + window` is the same bug with a smaller number.
 */
function recordCreatedAt(rawCreatedAt: unknown): Date {
  return clampFutureDate(rawCreatedAt, MTN_RECORD_MAX_FUTURE_SKEW_MS) ?? new Date();
}

/**
 * Reverse-resolve EVERY content address a post record references — the shared
 * `embed`, each variant's media override, and the blob keys of each variant's
 * localized `alt` map — into live Oxy file ids, in ONE batched lookup however
 * many languages the record carries.
 *
 * The lookup is `getServiceAssetMetadataBySha256` (core 5.2.0, `POST
 * /assets/service/by-sha256`) — the inverse of the write side's forward
 * `fileId → sha256`. Each resolved blob becomes a `MediaItem` whose `id` is the
 * Oxy fileId, so a materialized post renders through the EXISTING
 * `getFileDownloadUrl`/`mediaResolver` CDN path exactly like a native fileId
 * post — no new render path, no fake URL.
 *
 * Only `active` assets are renderable; a `trash`ed one is treated as
 * unresolvable rather than linked to a dead file. FAIL-SOFT — NEVER THROWS: a
 * blob with no live asset here (unknown/trashed — the upstream omits it from the
 * batch) is DROPPED, and any lookup error (e.g. a `files:read`-scope 403 on the
 * federation credential) yields an empty index. Every downstream resolution then
 * degrades to "no media" and projection continues; the caller skips the empty
 * write, so an existing post's media survives (zero-regression guard).
 */
async function resolveRecordFileIds(record: MentionPostRecord): Promise<Map<string, string>> {
  const sha256s = new Set<string>();

  const collectEmbed = (embed: MtnMediaEmbed | undefined): void => {
    if (!embed || !Array.isArray(embed.items)) return;
    for (const item of embed.items) {
      const sha256 = item.blob?.sha256;
      if (typeof sha256 === 'string' && sha256.length > 0) sha256s.add(sha256);
    }
  };

  collectEmbed(record.embed);
  for (const variant of record.variants ?? []) {
    collectEmbed(variant.embed);
    for (const sha256 of Object.keys(variant.alt ?? {})) {
      if (sha256.length > 0) sha256s.add(sha256);
    }
  }

  if (sha256s.size === 0) return new Map();

  try {
    const metadata = await getServiceOxyClient().getServiceAssetMetadataBySha256([...sha256s]);
    const fileIdBySha256 = new Map<string, string>();
    for (const entry of metadata) {
      if (entry.status === 'active' && typeof entry.id === 'string' && entry.id.length > 0) {
        fileIdBySha256.set(entry.sha256, entry.id);
      }
    }
    return fileIdBySha256;
  } catch (error) {
    // Best-effort: a failed reverse lookup must never abort projection.
    logger.warn('PostMaterializer: content-address lookup failed; projecting without record media', {
      sha256Count: sha256s.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/**
 * Project a record's body back onto native content variants — the post's ONLY
 * body storage. Every variant on the chain is authored by definition (a machine
 * translation is never signed), so they all materialize as `source:'author'`.
 *
 * TWO SHAPES, one output:
 *  - A MULTILINGUAL record carries `variants[]`, each with its own tag.
 *  - A MONOLINGUAL record carries none — its single body is the record's primary
 *    `text`, tagged by `langs[0]`. Emitting a one-entry `variants` array on the
 *    wire would just be a second copy of `text`, so the writer omits it and this
 *    reader reconstitutes it. That is also the DEGRADATION path: a record written
 *    by a reader that never heard of `variants` still materializes a complete,
 *    correctly-tagged post from `text` + `langs` alone.
 *
 * The body may end up UNTAGGED (no `langs`, or an unusable one). That is a real
 * state, not a failure: the post is text nobody could assign a language to.
 *
 * The `alt` map is re-keyed from blob `sha256` (what the chain speaks) back to
 * the Oxy media id (what the renderer speaks); an entry whose blob is not
 * mirrored here is dropped rather than left pointing at a key no renderer can
 * match. `alt` and `media` are mutually exclusive by the content model, so a
 * (malformed) record carrying both keeps the media override and drops the alt
 * map — never two sources of truth for one alt text.
 *
 * A variant whose media override resolves to NOTHING (its blobs are not mirrored
 * here yet) is materialized WITHOUT a media set, so it inherits the shared one.
 * Inheriting the post's real images beats rendering a variant with none.
 */
function buildVariantsFromRecord(
  record: MentionPostRecord,
  fileIdBySha256: Map<string, string>,
  createdAt: Date,
): PostContentVariant[] {
  const variants: PostContentVariant[] = [];
  const createdAtIso = createdAt.toISOString();

  // Monolingual record: rebuild the single primary rendition from `text`+`langs`.
  if (!record.variants || record.variants.length === 0) {
    const text = typeof record.text === 'string' ? record.text : '';
    // An empty body has no rendition at all (a boost) — not an empty one.
    if (text.length === 0) return [];
    const primary: PostContentVariant = { source: 'author', text, createdAt: createdAtIso };
    const tag = canonicalizeLanguageTag(record.langs?.[0]);
    if (tag !== null) primary.tag = tag;
    return [primary];
  }

  for (const source of record.variants) {
    const tag = canonicalizeLanguageTag(source.tag);
    if (tag === null || typeof source.text !== 'string') continue;

    const variant: PostContentVariant = {
      tag,
      source: 'author',
      text: source.text,
      createdAt: createdAtIso,
    };

    const media = resolveEmbedItemsToMedia(source.embed, fileIdBySha256);
    if (media.length > 0) {
      variant.media = media;
    } else if (source.alt) {
      const alt: Record<string, string> = {};
      for (const [sha256, text] of Object.entries(source.alt)) {
        if (typeof text !== 'string' || text.length === 0) continue;
        const fileId = fileIdBySha256.get(sha256);
        if (!fileId) continue;
        alt[fileId] = text;
      }
      if (Object.keys(alt).length > 0) variant.alt = alt;
    }

    if (source.article) {
      const article: NonNullable<PostContentVariant['article']> = {};
      if (source.article.title) article.title = source.article.title;
      if (source.article.body) article.body = source.article.body;
      if (source.article.excerpt) article.excerpt = source.article.excerpt;
      if (Object.keys(article).length > 0) variant.article = article;
    }

    variants.push(variant);
  }

  return variants;
}

/**
 * The synchronous core of the blob → MediaItem mapping, shared by the shared
 * embed and every variant override (the network lookup already happened once, in
 * {@link resolveRecordFileIds}).
 */
function resolveEmbedItemsToMedia(
  embed: MtnMediaEmbed | undefined,
  fileIdBySha256: Map<string, string>,
): MediaItem[] {
  if (!embed || !Array.isArray(embed.items) || embed.items.length === 0) return [];

  const media: MediaItem[] = [];
  for (const item of embed.items) {
    const blob = item.blob;
    if (!blob || typeof blob.sha256 !== 'string' || blob.sha256.length === 0) continue;
    const fileId = fileIdBySha256.get(blob.sha256);
    if (!fileId) continue;
    const resolved: MediaItem = { id: fileId, type: blob.mediaType };
    if (typeof item.alt === 'string' && item.alt.length > 0) {
      resolved.alt = item.alt;
    }
    media.push(resolved);
  }
  return media;
}

/**
 * Recover the post id (rkey) referenced by an MTN URI. Returns `null` when the
 * URI is not a parseable MTN URI.
 */
function rkeyFromMtnUri(uri: string): string | null {
  if (!MtnUri.isValid(uri)) return null;
  try {
    return MtnUri.parse(uri).rkey;
  } catch {
    return null;
  }
}

/**
 * Which of `ids` name a post that exists.
 *
 * `posts.parent_post_id`, `thread_id` and `boost_of` are real foreign keys, so an
 * id that names no row cannot be stored at all — the insert would fail and take
 * the whole projection with it. Resolving first turns "the parent is not here
 * yet" from a hard error into a decision each caller makes explicitly.
 */
async function existingPostIds(tx: Transaction, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Set();
  const rows = await tx
    .select({ id: posts.id })
    .from(posts)
    .where(inArray(posts.id, unique));
  return new Set(rows.map((row) => row.id));
}

/** The classification columns a Stage-A baseline writes, plus the primary language. */
interface ClassificationColumns {
  classificationTopics: string[];
  classificationLanguages: string[];
  classificationRegion: string | null;
  classificationHashtagsNorm: string[];
  classificationSensitive: boolean | null;
  classificationVersion: number;
  classificationStatus: typeof POST_CLASSIFICATION_PENDING;
  classificationAttempts: number;
  classificationClassifiedAt: Date;
  classificationScoreToxicity: number;
  classificationScoreConstructiveness: number;
  classificationScoreSpam: number;
  classificationScoreQuality: number;
  classificationScoreControversy: number;
  classificationScoreNegativity: number;
  /** `languages[0]` — overrides the record's own primary when the classifier resolved one. */
  language?: string;
}

/**
 * Build the Stage-A classification columns for a post record, MIRRORING
 * `PostCreationService.applyBaselineClassification` EXACTLY so a materialized
 * post's classification is identical to a natively-created one.
 *
 * Best-effort: the classifier is pure/synchronous, but any throw is caught so it
 * can never fail projection — the caller then leaves the column defaults in place
 * (mirrors PostCreationService).
 */
function buildClassificationColumns(record: MentionPostRecord): ClassificationColumns | null {
  try {
    const signals = baselineContentClassifier.classify({
      text: record.text,
      hashtags: record.tags,
      // The record's `langs[0]` is the primary; the full `langs` list is the
      // declared/authoritative set (same precedence the native path uses).
      language: record.langs?.[0],
      languages: record.langs,
      // A federated post never emits a record, so a materialized post is always
      // native: no `sensitive`/`instanceDomain` source flag to thread through.
    });

    const columns: ClassificationColumns = {
      classificationTopics: signals.topics,
      classificationLanguages: signals.languages,
      classificationRegion: signals.region ?? null,
      classificationHashtagsNorm: signals.hashtagsNorm,
      classificationSensitive: signals.sensitive ?? null,
      classificationVersion: signals.version,
      classificationStatus: POST_CLASSIFICATION_PENDING,
      classificationAttempts: 0,
      classificationClassifiedAt: new Date(signals.classifiedAt),
      classificationScoreToxicity: signals.scores.toxicity,
      classificationScoreConstructiveness: signals.scores.constructiveness,
      classificationScoreSpam: signals.scores.spam,
      classificationScoreQuality: signals.scores.quality,
      classificationScoreControversy: signals.scores.controversy,
      classificationScoreNegativity: signals.scores.negativity,
    };

    // Keep the top-level AP `post.language` in sync with the resolved primary
    // (`languages[0]`), exactly as PostCreationService does.
    const primaryLanguage = signals.languages[0];
    if (primaryLanguage != null) {
      columns.language = primaryLanguage;
    }

    return columns;
  } catch (error) {
    // Never fail projection on classification — leave the column defaults.
    logger.warn('PostMaterializer: baseline classification failed; projecting without Stage-A signals', error);
    return null;
  }
}

/** Replace a post's authorship rows with the record owner's sole `owner` entry. */
async function writeAuthorship(tx: Transaction, postId: string, oxyUserId: string): Promise<void> {
  await tx.delete(postAuthorships).where(eq(postAuthorships.postId, postId));
  await tx.insert(postAuthorships).values(
    buildAuthorship(oxyUserId, []).map((entry) => ({
      postId,
      oxyUserId: entry.oxyUserId,
      role: entry.role,
      status: entry.status,
      invitedAt: entry.invitedAt ? new Date(entry.invitedAt) : null,
      respondedAt: entry.respondedAt ? new Date(entry.respondedAt) : null,
    })),
  );
}

/** The `variantCreatedAt` of a rendition, or NULL when the string is not a date. */
function variantDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Replace a post's body — its variants, each variant's media override and each
 * variant's localized alt map — in one pass.
 *
 * ALWAYS replaces, even with an empty list, so a re-projection can never leave a
 * stale rendition of a body the chain has since changed. Variant ids are minted
 * here rather than read back from the insert, so the children can be written in
 * ONE statement instead of one round trip per rendition.
 */
async function writeVariants(
  tx: Transaction,
  postId: string,
  variants: PostContentVariant[],
): Promise<void> {
  // The children cascade from `post_content_variants`, so one delete clears all three.
  await tx.delete(postContentVariants).where(eq(postContentVariants.postId, postId));
  if (variants.length === 0) return;

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
      variantCreatedAt: variantDate(variant.createdAt),
    })),
  );

  const overrideMedia = variants.flatMap((variant, index) =>
    (variant.media ?? []).map((item, position) => ({
      variantId: variantIds[index],
      position,
      mediaId: item.id,
      type: item.type,
      alt: item.alt ?? null,
    })),
  );
  if (overrideMedia.length > 0) {
    await tx.insert(postVariantMedia).values(overrideMedia);
  }

  const altTexts = variants.flatMap((variant, index) =>
    Object.entries(variant.alt ?? {}).map(([mediaId, description]) => ({
      variantId: variantIds[index],
      mediaId,
      description,
    })),
  );
  if (altTexts.length > 0) {
    await tx.insert(postVariantAltTexts).values(altTexts);
  }
}

/**
 * Project an `app.mention.feed.post` record into a `posts` row and its child
 * rows, confined to `{ id: rkey, oxy_user_id }`.
 *
 * `post_media` is replaced ONLY when the record's content-addressed `embed`
 * RESOLVES to ≥1 live MediaItem ({@link resolveEmbedItemsToMedia}); an empty
 * resolution leaves the existing media untouched (zero-regression guard).
 */
async function projectPost(
  rkey: string,
  oxyUserId: string,
  record: MentionPostRecord,
  createdAt: Date,
): Promise<ProjectResult> {
  // Recover the reply context from the MTN reply ref. `threadId` is the reply
  // ROOT's rkey; `parentPostId` is the direct PARENT's rkey. A top-level post
  // (no reply) → both null.
  const declaredParentId = record.reply ? rkeyFromMtnUri(record.reply.parent) : null;
  const declaredThreadId = record.reply ? rkeyFromMtnUri(record.reply.root) : null;

  const tags = Array.isArray(record.tags) ? [...record.tags] : [];

  // ONE content-address lookup for the whole record: the shared embed, every
  // variant's media override, and the blob keys of every variant's `alt` map.
  // Outside the transaction — it is a network call, not a write.
  const fileIdBySha256 = await resolveRecordFileIds(record);
  const media = resolveEmbedItemsToMedia(record.embed, fileIdBySha256);
  const variants = buildVariantsFromRecord(record, fileIdBySha256, createdAt);
  const classification = buildClassificationColumns(record);

  // The record's `langs` are BCP-47 (`es-ES`) while the top-level `language` is a
  // BASE subtag (the classifier's alphabet), so normalize rather than storing a
  // regional tag in a field the ranking layer reads as a base code. The
  // classifier's own resolved primary wins when it produced one.
  const recordPrimary = toBaseLanguage(record.langs?.[0]);
  const language = classification?.language ?? recordPrimary ?? null;

  return getDb().transaction(async (tx) => {
    const linkable = await existingPostIds(tx, [declaredParentId ?? '', declaredThreadId ?? '']);
    const parentPostId = declaredParentId && linkable.has(declaredParentId) ? declaredParentId : null;
    const threadId = declaredThreadId && linkable.has(declaredThreadId) ? declaredThreadId : null;
    if (declaredParentId && !parentPostId) {
      logger.info('PostMaterializer: reply parent is not materialized here; leaving the reply unlinked', {
        rkey,
        parentPostId: declaredParentId,
      });
    }

    const owned = {
      oxyUserId,
      type: PostType.TEXT,
      hashtags: tags,
      parentPostId,
      threadId,
      language,
      createdAt,
      updatedAt: new Date(),
      ...(classification === null
        ? {}
        : {
            classificationTopics: classification.classificationTopics,
            classificationLanguages: classification.classificationLanguages,
            classificationRegion: classification.classificationRegion,
            classificationHashtagsNorm: classification.classificationHashtagsNorm,
            classificationSensitive: classification.classificationSensitive,
            classificationVersion: classification.classificationVersion,
            classificationStatus: classification.classificationStatus,
            classificationAttempts: classification.classificationAttempts,
            classificationClassifiedAt: classification.classificationClassifiedAt,
            classificationScoreToxicity: classification.classificationScoreToxicity,
            classificationScoreConstructiveness: classification.classificationScoreConstructiveness,
            classificationScoreSpam: classification.classificationScoreSpam,
            classificationScoreQuality: classification.classificationScoreQuality,
            classificationScoreControversy: classification.classificationScoreControversy,
            classificationScoreNegativity: classification.classificationScoreNegativity,
          }),
      // A coordinate pair is all-or-nothing (`posts_content_location_pair_check`),
      // and the geography point is GENERATED from these two columns — there is no
      // hand-written point to disagree with them.
      ...(record.location
        ? {
            contentLocationLongitude: record.location.coordinates[0],
            contentLocationLatitude: record.location.coordinates[1],
          }
        : {}),
    };

    // OWNER-SCOPED upsert: `DO UPDATE … WHERE posts.oxy_user_id = $owner` updates
    // nothing when the rkey already belongs to someone else, and the empty
    // RETURNING is how that is detected — atomically failing closed instead of
    // overwriting the other user's post.
    const [upserted] = await tx
      .insert(posts)
      .values({
        id: rkey,
        // Only on INSERT — an existing post keeps whatever visibility/status it has.
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        ...owned,
      })
      .onConflictDoUpdate({
        target: posts.id,
        set: owned,
        setWhere: eq(posts.oxyUserId, oxyUserId),
      })
      .returning({ id: posts.id });

    if (!upserted) {
      // The transaction has written nothing else yet, so returning here leaves no
      // partial row behind.
      return { ok: false, reason: 'record_owner_mismatch' };
    }

    await writeAuthorship(tx, rkey, oxyUserId);
    await writeVariants(tx, rkey, variants);

    // Only replace the shared media set when ≥1 blob resolved — an empty result
    // (no embed, or blobs not yet in our S3) is intentionally SKIPPED so the
    // upsert never clobbers an existing post's fileId media to empty.
    if (media.length > 0) {
      await tx.delete(postMedia).where(eq(postMedia.postId, rkey));
      await tx.insert(postMedia).values(
        media.map((item, position) => ({
          postId: rkey,
          position,
          mediaId: item.id,
          type: item.type,
          alt: item.alt ?? null,
        })),
      );
    }

    // Source links: only when the record carries them, mirroring the Mongo `$set`
    // — an absent `sources` leaves the existing list alone.
    if (Array.isArray(record.sources) && record.sources.length > 0) {
      await tx.delete(postSources).where(eq(postSources.postId, rkey));
      await tx.insert(postSources).values(
        record.sources.map((source, position) => ({
          postId: rkey,
          position,
          url: source.url,
          title: source.title ?? null,
        })),
      );
    }

    if (parentPostId) {
      await recordRecentReplierForPost({
        parentPostId,
        oxyUserId,
        createdAt,
        visibility: PostVisibility.PUBLIC,
        status: 'published',
      });
    }

    return { ok: true, kind: 'post', id: rkey };
  });
}

/** Project an `app.mention.feed.like` record into a `Like` row (upsert by id). */
async function projectLike(
  rkey: string,
  userId: string,
  record: MentionLikeRecord,
): Promise<ProjectResult> {
  const likedRkey = rkeyFromMtnUri(record.subject);
  if (!likedRkey) return { ok: false, reason: 'unresolvable_like_subject' };

  await materializeEngagementRelationship({
    kind: 'like',
    relationshipId: rkey,
    userId,
    postId: likedRkey,
  });

  return { ok: true, kind: 'like', id: rkey };
}

/**
 * Project an `app.mention.feed.repost` record into a `type: 'boost'` post row,
 * confined to `{ id: rkey, oxy_user_id }`. A boost has an INTENTIONALLY EMPTY
 * body and relies on `boost_of` for hydration (see the boost-hydration gotcha).
 *
 * "Empty body" means NO RENDITION — no `post_content_variants` row at all, not a
 * rendition whose body happens to be `''`. A boost has nothing to say in any
 * language, so there is nothing to tag.
 *
 * A boost whose ORIGINAL is not materialized here is REFUSED rather than stored
 * with a null `boost_of`: `boost_of` is a foreign key now, and a boost that
 * points at nothing renders as a permanently blank card. Refusing keeps the
 * projection re-runnable — the boost lands the moment the original does.
 */
async function projectRepost(
  rkey: string,
  oxyUserId: string,
  record: MentionRepostRecord,
  createdAt: Date,
): Promise<ProjectResult> {
  const boostOf = rkeyFromMtnUri(record.subject);
  if (!boostOf) return { ok: false, reason: 'unresolvable_repost_subject' };

  return getDb().transaction(async (tx) => {
    const existing = await existingPostIds(tx, [boostOf]);
    if (!existing.has(boostOf)) {
      return { ok: false, reason: 'unmaterialized_repost_subject' };
    }

    const owned = {
      oxyUserId,
      type: PostType.BOOST,
      boostOf,
      createdAt,
      updatedAt: new Date(),
    };

    const [upserted] = await tx
      .insert(posts)
      .values({
        id: rkey,
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        ...owned,
      })
      .onConflictDoUpdate({
        target: posts.id,
        set: owned,
        setWhere: eq(posts.oxyUserId, oxyUserId),
      })
      .returning({ id: posts.id });

    if (!upserted) return { ok: false, reason: 'record_owner_mismatch' };

    await writeAuthorship(tx, rkey, oxyUserId);
    // A boost has no rendition at all; the delete is what makes a re-projection
    // over a former post row leave no stale body behind.
    await writeVariants(tx, rkey, []);

    return { ok: true, kind: 'repost', id: rkey };
  });
}

/** Project an `app.mention.feed.bookmark` record into a `Bookmark` row (upsert). */
async function projectBookmark(
  rkey: string,
  userId: string,
  record: MentionBookmarkRecord,
): Promise<ProjectResult> {
  const bookmarkedRkey = rkeyFromMtnUri(record.subject);
  if (!bookmarkedRkey) return { ok: false, reason: 'unresolvable_bookmark_subject' };

  await materializeEngagementRelationship({
    kind: 'bookmark',
    relationshipId: rkey,
    userId,
    postId: bookmarkedRkey,
  });

  return { ok: true, kind: 'bookmark', id: rkey };
}

/**
 * Project an `app.mention.feed.tombstone` record: remove the row referenced by
 * `record.subject`. The codebase removes these by HARD delete (delete-post is a
 * `findOneAndDelete`, unlike deletes the `Like`, unsave deletes the `Bookmark`),
 * so the materializer mirrors that. The subject's COLLECTION selects which row to
 * delete. Idempotent: removing an already-removed row is a no-op (still `ok`).
 */
async function projectTombstone(
  record: MentionTombstoneRecord,
  ownerOxyUserId: string,
): Promise<ProjectResult> {
  if (!MtnUri.isValid(record.subject)) {
    return { ok: false, reason: 'unresolvable_tombstone_subject' };
  }
  let subject: MtnUri;
  try {
    subject = MtnUri.parse(record.subject);
  } catch {
    return { ok: false, reason: 'unresolvable_tombstone_subject' };
  }

  const rkey = subject.rkey;
  if (subject.identity !== ownerOxyUserId) {
    return { ok: false, reason: 'tombstone_subject_owner_mismatch' };
  }

  switch (subject.collection) {
    case MENTION_POST_COLLECTION:
    case MENTION_REPOST_COLLECTION: {
      // A post or boost: delete it by id. The owner predicate prevents a valid
      // chain for account A from deleting account B's post by guessing its rkey.
      // Child rows (authorship, variants, media, sources) cascade.
      const [deleted] = await getDb()
        .delete(posts)
        .where(and(eq(posts.id, rkey), eq(posts.oxyUserId, ownerOxyUserId)))
        .returning({ id: posts.id, parentPostId: posts.parentPostId });
      if (deleted) {
        await repairRecentRepliersAfterPostDelete({
          postId: rkey,
          parentPostId: deleted.parentPostId,
        });
      }
      return { ok: true, kind: 'tombstone', id: rkey };
    }
    case MENTION_LIKE_COLLECTION:
      await materializeEngagementTombstone({
        kind: 'like',
        relationshipId: rkey,
        userId: ownerOxyUserId,
      });
      return { ok: true, kind: 'tombstone', id: rkey };
    case MENTION_BOOKMARK_COLLECTION:
      await materializeEngagementTombstone({
        kind: 'bookmark',
        relationshipId: rkey,
        userId: ownerOxyUserId,
      });
      return { ok: true, kind: 'tombstone', id: rkey };
    default:
      return { ok: false, reason: 'unsupported_tombstone_subject_collection' };
  }
}

/**
 * Project a VERIFIED `app.mention.feed.*` signed record into the feed-readable
 * store. Idempotent (keyed by `rkey`), zero-regression (the post upsert writes
 * only owned fields and preserves existing media), and NEVER throws — every
 * failure is returned as `{ ok: false, reason }`.
 *
 * The caller MUST pass a record whose signature/chain has already been verified
 * (by the protocol engine on the ingest/backfill side); this function validates
 * only the inner `record` PAYLOAD shape against the matching lexicon schema.
 *
 * @param envelope A verified v2 envelope with `collection`/`rkey`/`subject`/`record`.
 */
export async function projectRecord(envelope: SignedRecordEnvelope): Promise<ProjectResult> {
  try {
    const { collection, rkey, subject, record } = envelope;

    if (typeof collection !== 'string' || typeof rkey !== 'string' || rkey.length === 0) {
      return { ok: false, reason: 'missing_record_key' };
    }

    // The subject DID identifies the chain owner (the author / liker / bookmarker).
    // A non-parseable subject DID is a clear no-op (we cannot key a native row).
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return { ok: false, reason: 'unresolvable_subject_did' };
    }

    switch (collection) {
      case MENTION_POST_COLLECTION: {
        const parsed = mentionPostRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectPost(rkey, oxyUserId, parsed.data, recordCreatedAt(parsed.data.createdAt));
      }
      case MENTION_LIKE_COLLECTION: {
        const parsed = mentionLikeRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectLike(rkey, oxyUserId, parsed.data);
      }
      case MENTION_REPOST_COLLECTION: {
        const parsed = mentionRepostRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectRepost(rkey, oxyUserId, parsed.data, recordCreatedAt(parsed.data.createdAt));
      }
      case MENTION_TOMBSTONE_COLLECTION: {
        const parsed = mentionTombstoneRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectTombstone(parsed.data, oxyUserId);
      }
      case MENTION_BOOKMARK_COLLECTION: {
        const parsed = mentionBookmarkRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectBookmark(rkey, oxyUserId, parsed.data);
      }
      default:
        return { ok: false, reason: 'unsupported_collection' };
    }
  } catch (error) {
    logger.error('PostMaterializer: projectRecord failed', {
      collection: envelope.collection,
      rkey: envelope.rkey,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'error' };
  }
}
