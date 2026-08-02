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
 * **The owner scope is now a read, a comparison and a branch.** Mongo relied on
 * the `_id` unique index to reject an upsert that missed the owner filter, and
 * read the duplicate-key error as "someone else owns this rkey". Here the row is
 * loaded first and its owner compared before anything is written; the
 * duplicate-key path survives only as the race handler, where a concurrent
 * projection took the id between the read and the insert and the owner is
 * re-checked on the re-read.
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

import { eq, inArray } from 'drizzle-orm';
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
import type { StoredPostContent } from '@mention/shared-types';
import { PostType, PostVisibility } from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { isUniqueViolation } from '../../db/pgErrors';
import { posts } from '../../db/schema/posts';
import type { PostRecord, PostRecordClassification } from '../../db/posts/postRecord';
import {
  deletePostRecord,
  insertPostRecord,
  loadPostRecord,
  replacePostContent,
  updatePostRecord,
} from '../../db/posts/postRepository';
import { POST_CLASSIFICATION_PENDING } from '../../db/posts/postRecord';
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
 * The Stage-A classification a post record produces, plus its primary language.
 *
 * `PostRecordClassification` requires `status`, `attempts`, `sentiment`,
 * `intent`, `scores` and `confidence` because the columns are `NOT NULL`; the
 * baseline supplies the first two and the scores, and leaves the AI-only fields
 * at their neutral defaults.
 */
interface BaselineClassification {
  classification: Partial<PostRecordClassification>;
  /** `languages[0]` — overrides the record's own primary when the classifier resolved one. */
  language?: string;
}

/**
 * Build the Stage-A classification for a post record, MIRRORING
 * `PostCreationService.applyBaselineClassification` EXACTLY so a materialized
 * post's classification is identical to a natively-created one.
 *
 * Best-effort: the classifier is pure/synchronous, but any throw is caught so it
 * can never fail projection — the caller then leaves the column defaults in place
 * (mirrors PostCreationService).
 */
function buildBaselineClassification(record: MentionPostRecord): BaselineClassification | null {
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

    const result: BaselineClassification = {
      classification: {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: signals.topics,
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        trendTerms: signals.trendTerms,
        sensitive: signals.sensitive,
        version: signals.version,
        scores: signals.scores,
        classifiedAt: new Date(signals.classifiedAt),
      },
    };

    // Keep the top-level AP `post.language` in sync with the resolved primary
    // (`languages[0]`), exactly as PostCreationService does.
    const primaryLanguage = signals.languages[0];
    if (primaryLanguage != null) {
      result.language = primaryLanguage;
    }

    return result;
  } catch (error) {
    // Never fail projection on classification — leave the column defaults.
    logger.warn('PostMaterializer: baseline classification failed; projecting without Stage-A signals', error);
    return null;
  }
}

/**
 * Which of `ids` name a post that exists here.
 *
 * `posts.parent_post_id`, `thread_id` and `boost_of` are real foreign keys, so an
 * id that names no row cannot be stored at all — the insert would fail and take
 * the whole projection with it. Resolving first turns "the parent is not here
 * yet" from a hard error into a decision each caller makes explicitly.
 */
async function existingPostIds(
  ids: readonly (string | null)[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return new Set();
  const rows = await db.select({ id: posts.id }).from(posts).where(inArray(posts.id, unique));
  return new Set(rows.map((row) => row.id));
}

/**
 * The content graph a post record owns, laid over whatever the post already has.
 *
 * The record owns the body, the shared media set, the source links and the
 * shared location — and NOTHING else. `replacePostContent` writes the whole
 * graph, so an existing post's poll, article, event, room and podcast have to be
 * carried across explicitly or a re-projection would clear them; the Mongo
 * version got that for free from a dotted `$set` and it is the single easiest
 * thing to lose in this port.
 *
 * `media` is overridden ONLY when the record's content-addressed embed resolved
 * to ≥1 live item — the zero-regression guard. An empty resolution (no embed, or
 * blobs not mirrored here yet) leaves the post's existing media alone.
 */
function mergeRecordContent(
  existing: StoredPostContent | undefined,
  parts: {
    variants: PostContentVariant[];
    media: MediaItem[];
    sources?: MentionPostRecord['sources'];
    location?: MentionPostRecord['location'];
  },
): StoredPostContent {
  const content: StoredPostContent = { ...(existing ?? {}), variants: parts.variants };

  if (parts.media.length > 0) {
    content.media = parts.media;
  }

  if (Array.isArray(parts.sources) && parts.sources.length > 0) {
    content.sources = parts.sources.map((source) =>
      source.title ? { url: source.url, title: source.title } : { url: source.url },
    );
  }

  if (parts.location) {
    content.location = {
      type: 'Point',
      coordinates: [parts.location.coordinates[0], parts.location.coordinates[1]],
    };
  }

  return content;
}

/**
 * Refresh an EXISTING post row from a record, without touching its birth facts.
 *
 * `type`, `parent_post_id`, `is_reply`, `boost_of` and `created_at` are written
 * once and never rewritten here — a re-projection is an idempotent replay or an
 * edit, and neither reparents a post, changes what kind of post it is, or
 * re-dates it. That is a deliberate NARROWING of the Mongoose version, which
 * `$set` all five on every projection: the wide version let a later record
 * re-pin an old post to the top of every chronological feed, which is the same
 * shape as the future-`createdAt` bug `recordCreatedAt` exists to stop.
 *
 * `mentions` are carried across because `replacePostContent` rewrites that table
 * from its argument, and a chain record carries no mention allowlist — passing
 * an empty list would silently strip an existing post's resolved @mentions.
 *
 * AUTHORSHIP is not rewritten either, and that is the same rule rather than an
 * omission. A post record carries only its subject; rewriting the authorship
 * from it would REVOKE every collaborator on every re-projection, which is what
 * the Mongoose version did (`$set: { authorship: buildAuthorship(subject, []) }`)
 * and what `replacePostContent` deliberately refuses to do for the same reason.
 * The owner is already established: the caller only reaches here after matching
 * `existing.oxyUserId` against the record's subject.
 */
async function refreshProjectedPost(
  existing: PostRecord,
  content: StoredPostContent,
  patch: { hashtags: string[]; language: string | null; threadId: string | null },
  classification: Partial<PostRecordClassification> | undefined,
): Promise<void> {
  await updatePostRecord(existing.id, {
    hashtags: patch.hashtags,
    language: patch.language,
    // Only ever ADDS the link: a thread root that has not been materialized yet
    // resolves to null, and clearing a link the post already has would orphan it
    // from its own thread.
    ...(patch.threadId === null ? {} : { threadId: patch.threadId }),
    ...(classification === undefined ? {} : { postClassification: classification }),
  });
  await replacePostContent(existing.id, content, existing.mentions);
}

/**
 * Project an `app.mention.feed.post` record into a `posts` row and every child
 * row it owns, confined to `{ id: rkey, oxy_user_id }`.
 *
 * The owner scope is the whole reason this is a read-then-branch rather than a
 * blind upsert: an `rkey` is a key in the SUBJECT's namespace, so a genuinely
 * signed record whose author knows another user's post id must fail closed
 * (`record_owner_mismatch`) instead of rewriting that user's post.
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

  // ONE content-address lookup for the whole record: the shared embed, every
  // variant's media override, and the blob keys of every variant's `alt` map.
  const fileIdBySha256 = await resolveRecordFileIds(record);
  const media = resolveEmbedItemsToMedia(record.embed, fileIdBySha256);
  const variants = buildVariantsFromRecord(record, fileIdBySha256, createdAt);
  const baseline = buildBaselineClassification(record);

  // The record's `langs` are BCP-47 (`es-ES`) while the top-level `language` is a
  // BASE subtag (the classifier's alphabet), so normalize rather than storing a
  // regional tag in a field the ranking layer reads as a base code. The
  // classifier's own resolved primary wins when it produced one.
  const language = baseline?.language ?? toBaseLanguage(record.langs?.[0]) ?? null;
  const hashtags = Array.isArray(record.tags) ? [...record.tags] : [];

  const linkable = await existingPostIds([declaredParentId, declaredThreadId]);
  const parentPostId = declaredParentId && linkable.has(declaredParentId) ? declaredParentId : null;
  const threadId = declaredThreadId && linkable.has(declaredThreadId) ? declaredThreadId : null;
  if (declaredParentId && !parentPostId) {
    logger.info('PostMaterializer: reply parent is not materialized here; leaving the reply unlinked', {
      rkey,
      parentPostId: declaredParentId,
    });
  }

  const existing = await loadPostRecord(rkey);
  if (existing && existing.oxyUserId !== oxyUserId) {
    return { ok: false, reason: 'record_owner_mismatch' };
  }

  const content = mergeRecordContent(existing?.content, {
    variants,
    media,
    sources: record.sources,
    location: record.location,
  });

  if (existing) {
    await refreshProjectedPost(existing, content, { hashtags, language, threadId }, baseline?.classification);
  } else {
    try {
      await insertPostRecord({
        id: rkey,
        oxyUserId,
        authorship: buildAuthorship(oxyUserId, []),
        type: PostType.TEXT,
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        language: language ?? undefined,
        hashtags,
        parentPostId,
        threadId,
        // The record SAYS it is a reply even when its parent is not here, and
        // the stored discriminator has to hold that or the reply is promoted
        // into For You / Following / Explore. See `PostRecordInput.declaredReply`.
        declaredReply: Boolean(record.reply),
        content,
        createdAt,
        updatedAt: createdAt,
        ...(baseline === null ? {} : { postClassification: baseline.classification }),
      });
    } catch (error) {
      // A concurrent projection of the SAME rkey took the id first. Re-read and
      // take the update path, which owner-checks again — so a race with another
      // subject still fails closed rather than being reported as our own write.
      if (!isUniqueViolation(error)) throw error;
      const raced = await loadPostRecord(rkey);
      if (!raced || raced.oxyUserId !== oxyUserId) {
        return { ok: false, reason: 'record_owner_mismatch' };
      }
      await refreshProjectedPost(raced, content, { hashtags, language, threadId }, baseline?.classification);
    }
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

  const existing = await loadPostRecord(rkey);
  if (existing && existing.oxyUserId !== oxyUserId) {
    return { ok: false, reason: 'record_owner_mismatch' };
  }

  if (existing) {
    // A birth fact cannot change: an rkey that already names a post of some other
    // shape is a conflict, not something to rewrite into a boost.
    if (existing.type !== PostType.BOOST || existing.boostOf !== boostOf) {
      return { ok: false, reason: 'repost_subject_mismatch' };
    }
    // Authorship is not rewritten — the owner was already established by the
    // check above, and the record does not own that list (see
    // {@link refreshProjectedPost}). The delete-then-insert is what makes a
    // re-projection leave no stale body behind.
    await replacePostContent(rkey, { variants: [] }, existing.mentions);
    return { ok: true, kind: 'repost', id: rkey };
  }

  if (!(await existingPostIds([boostOf])).has(boostOf)) {
    return { ok: false, reason: 'unmaterialized_repost_subject' };
  }

  try {
    await insertPostRecord({
      id: rkey,
      oxyUserId,
      authorship: buildAuthorship(oxyUserId, []),
      type: PostType.BOOST,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      boostOf,
      content: { variants: [] },
      createdAt,
      updatedAt: createdAt,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { ok: false, reason: 'record_owner_mismatch' };
  }

  return { ok: true, kind: 'repost', id: rkey };
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
      const deleted = await deletePostRecord(rkey, eq(posts.oxyUserId, ownerOxyUserId));
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
 * store. Idempotent (keyed by `rkey`), zero-regression (an existing post keeps
 * the media, mentions and attachments the record does not own), and NEVER throws
 * — every failure is returned as `{ ok: false, reason }`.
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
