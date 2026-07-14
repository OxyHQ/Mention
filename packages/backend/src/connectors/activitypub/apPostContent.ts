import {
  MAX_AUTHOR_VARIANTS,
  canonicalizeLanguageTag,
  type MediaItem,
  type PostContentVariant,
} from '@mention/shared-types';
import { normalizeInlineText, normalizeMultilineText } from '@oxyhq/core';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { normalizePostHashtags } from '../../utils/textProcessing';
import { materializeFederatedMedia, type ExtractedMediaAttachment } from '../shared/federatedMedia';
import { extractApHashtags, extractApMedia } from './helpers';
import { extractApLanguage, getApContentMap } from './apLanguage';

/**
 * Shared body-extraction + empty-note guard for federated ActivityPub Notes.
 *
 * Historically the three federated ingest sites — inbox `Create`, outbox
 * backfill, and boost/ancestor `ensureFederatedNote` — each built the post body
 * inline from `object.content` ONLY. Three problems fell out of that:
 *  1. A Mastodon status can carry its visible text in a `contentMap` localized
 *     variant with an EMPTY top-level `content` — those posts stored blank.
 *  2. Only the outbox path ran {@link normalizePostHashtags}, so an all-hashtag
 *     post stored differently depending on which path ingested it (asymmetry).
 *  3. Nothing rejected a genuinely empty Note (no text, no surviving media, no
 *     content-warning), so media-only posts whose only attachment was dropped as
 *     permanently unavailable were stored as empty `type:'text'` posts that
 *     render blank.
 *
 * This module centralizes the extraction so all three paths share one code path:
 * the `contentMap` fallback, the hashtag normalization, media materialization,
 * and the single empty-note guard.
 *
 * It also owns the MULTILINGUAL extraction: a `contentMap` is not a fallback
 * source for one body, it is one body PER LANGUAGE. Every entry is persisted as
 * an author variant ({@link BuiltFederatedNoteContent.variants}) with the primary
 * one first, so a bilingual remote status keeps both bodies instead of having all
 * but one silently discarded.
 */

/** Extraction inputs shared by every federated ingest site. */
export interface BuildFederatedNoteContentContext {
  activityId?: string;
  actorUri?: string;
}

/** A federated Note that resolved to storable content. */
export interface BuiltFederatedNoteContent {
  skip?: false;
  /**
   * The PRIMARY body, plain-text and hashtag-normalized. Possibly empty (a
   * media-only or CW-only note).
   *
   * This is an EXTRACTION result, not a storage field — there is no stored
   * `content.text` any more. It exists because the empty-note guard and the
   * Stage-A classifier both need the primary body, and both run before the post
   * is written. What gets STORED is {@link BuiltFederatedNoteContent.variants}.
   */
  text: string;
  /** Materialized media (remote media dropped/rewritten by the cache layer). */
  media: MediaItem[];
  /** Attachment descriptors aligned with {@link BuiltFederatedNoteContent.media}. */
  attachments: ExtractedMediaAttachment[];
  /** Normalized hashtags (inline + AP `tag` array). */
  hashtags: string[];
  /** Content-warning summary (AP `summary`), when present and non-empty. */
  summary: string | undefined;
  /** AP `sensitive` flag, normalized to a strict boolean. */
  sensitive: boolean;
  /**
   * Every AUTHOR-written localized body the origin published — the post's ONLY
   * body storage. `variants[0]` is the primary.
   *
   * Empty ONLY when the note has no body at all (media-only / CW-only): a body
   * with no resolvable language still gets a variant, just an UNTAGGED one. A
   * great many federated Notes declare no `language` and no `contentMap`, and
   * inventing a tag for them from a detector's guess would federate a lie.
   */
  variants: PostContentVariant[];
}

/** A federated Note that carries nothing storable and must be skipped. */
export interface SkippedFederatedNoteContent {
  skip: true;
  reason: string;
}

/**
 * Extract the HTML content body from an AP object, falling back to a
 * `contentMap` localized variant when the top-level `content` is empty.
 *
 * Fallback order:
 *  1. `object.content` when it is a non-empty string.
 *  2. The `contentMap` variant matching the object's declared primary language
 *     ({@link extractApLanguage}), matched on the ISO 639-1 primary subtag.
 *  3. The first non-empty `contentMap` variant (single/first key) otherwise.
 *
 * Pure / no I/O. Returns `''` when no usable content body is present.
 */
export function extractApContentHtml(object: Record<string, unknown> | null | undefined): string {
  if (!object || typeof object !== 'object') return '';

  const content = object.content;
  if (typeof content === 'string' && content.trim().length > 0) return content;

  const contentMap = getApContentMap(object);
  if (!contentMap) return '';

  // Prefer the variant for the declared primary language when we can resolve one.
  const preferred = extractApLanguage(object);
  if (preferred) {
    for (const [key, value] of Object.entries(contentMap)) {
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      const primary = key.trim().toLowerCase().split('-')[0];
      if (primary === preferred) return value;
    }
  }

  // Otherwise take the first non-empty localized variant.
  for (const value of Object.values(contentMap)) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }

  return '';
}

/**
 * The canonical BCP-47 tag of the body {@link extractApContentHtml} selected, or
 * `undefined` when the origin declared no language at all.
 *
 * Resolution mirrors the body selection so the tag and the text can never
 * disagree:
 *  1. the object's declared top-level `language`;
 *  2. the `contentMap` key whose value IS the selected body;
 *  3. the single `contentMap` key, when there is exactly one.
 *
 * A tag that is not structurally valid BCP-47 is REJECTED (never stored): an
 * invalid tag is worse than no tag — it would ride out to the fediverse on the
 * next boost and get the status rejected wholesale.
 */
function resolveApPrimaryTag(
  object: Record<string, unknown>,
  primaryHtml: string,
): string | undefined {
  const declared = canonicalizeLanguageTag(object.language);
  if (declared !== null) return declared;

  const contentMap = getApContentMap(object);
  if (!contentMap) return undefined;

  for (const [key, value] of Object.entries(contentMap)) {
    if (value !== primaryHtml) continue;
    const tag = canonicalizeLanguageTag(key);
    if (tag !== null) return tag;
  }

  const keys = Object.keys(contentMap);
  if (keys.length === 1) return canonicalizeLanguageTag(keys[0]) ?? undefined;

  return undefined;
}

/**
 * Turn one remote HTML body into the plain text we store: HTML stripped, spammy
 * hashtag blocks removed, whitespace normalized — the SAME treatment the primary
 * body gets, so a localized variant is never stored as raw markup.
 *
 * The all-hashtag restore is preserved: when normalization empties a body that
 * DID carry visible text and the note has no media, the raw text is kept rather
 * than blanking the rendition.
 */
function normalizeRemoteBody(html: string, hasMedia: boolean): string {
  const rawText = htmlToPlainText(html);
  const { content } = normalizePostHashtags(rawText);
  const text = normalizeMultilineText(content);
  if (text.length === 0 && rawText.length > 0 && !hasMedia) return rawText;
  return text;
}

/**
 * Every AUTHOR-written localized body the origin published — the post's ONLY
 * body storage. `variants[0]` is the primary.
 *
 * A bilingual Mastodon status carries one body per language in `contentMap`; the
 * old extraction collapsed that map to a single string and threw the rest away
 * (the language CODES survived through `extractApLanguages` — only the text was
 * lost). Each entry becomes a `source:'author'` variant, so the reader sees the
 * body the author actually wrote in their own language rather than a machine
 * translation of the other one.
 *
 * The primary is seeded first from the ALREADY-NORMALIZED primary body, then the
 * remaining map entries follow in the order the origin declared them. Capped at
 * {@link MAX_AUTHOR_VARIANTS} — the same ceiling the composer, the classifier and
 * the lexicon use — so a hostile origin cannot grow a post without bound.
 *
 * The primary variant is UNTAGGED when the origin declared no language. That is
 * the common case, not an edge: most non-Mastodon AP servers send neither
 * `language` nor `contentMap`. The body must still be stored (it is the post),
 * and the honest way to store it is without a tag — minting one from a
 * detector's best guess would stamp a wrong language on the post and then
 * federate that lie onward in `contentMap`/`language`.
 *
 * An empty body yields NO variant at all: a media-only or CW-only note has no
 * rendition, the same way a boost has none. An empty NON-primary body is dropped
 * for the same reason.
 */
function buildApAuthorVariants(
  object: Record<string, unknown>,
  primaryTag: string | undefined,
  primaryText: string,
  hasMedia: boolean,
): PostContentVariant[] {
  if (primaryText.length === 0) return [];

  const primary: PostContentVariant = { source: 'author', text: primaryText };
  if (primaryTag) primary.tag = primaryTag;
  const variants: PostContentVariant[] = [primary];

  const contentMap = getApContentMap(object);
  if (contentMap) {
    for (const [key, value] of Object.entries(contentMap)) {
      if (variants.length >= MAX_AUTHOR_VARIANTS) break;
      if (typeof value !== 'string') continue;
      const tag = canonicalizeLanguageTag(key);
      if (tag === null || variants.some((variant) => variant.tag === tag)) continue;
      const text = normalizeRemoteBody(value, hasMedia);
      if (text.length === 0) continue;
      variants.push({ tag, source: 'author', text });
    }
  }

  return variants;
}

/**
 * Extract the AP `summary` — the content warning we store as
 * `federation.spoilerText` — as normalized plain text.
 *
 * Two things the raw field cannot be trusted for:
 *  1. It is HTML on some servers (the AP spec types it as a natural-language
 *     HTML string, and Mastodon's own CW is plain text only by convention), so
 *     it goes through {@link htmlToPlainText} exactly like the body — otherwise
 *     raw tags reach the CW label in the UI.
 *  2. It arrives with the remote markup's whitespace. A CW label is ONE LINE, so
 *     it is finished with `normalizeInlineText`: an embedded newline would be
 *     rendered verbatim by the client (`white-space: pre-wrap`) and break the
 *     label's layout.
 *
 * Returns `undefined` for a missing / non-string / whitespace-only summary,
 * which is what the empty-note guard and the `Update` unset path both key on.
 */
export function extractApSummary(object: Record<string, unknown> | null | undefined): string | undefined {
  const raw = object?.summary;
  if (typeof raw !== 'string') return undefined;
  const summary = normalizeInlineText(htmlToPlainText(raw));
  return summary.length > 0 ? summary : undefined;
}

/**
 * Assemble the storable fields of a federated Note from its AP object WITHOUT
 * the empty-note guard: `contentMap`-aware body extraction, hashtag
 * normalization, media materialization, the all-hashtag "don't blank" restore,
 * and `summary`/`sensitive` passthrough.
 *
 * This is the single source of truth for how a federated Note maps to Mention
 * post fields. Both the create path ({@link buildFederatedNoteContent}, which
 * layers the empty-note guard on top) and the edit path
 * ({@link buildFederatedNoteContentForEdit}, which applies the fields as-is)
 * call it, so a `contentMap`-only / CW / all-hashtag note is extracted
 * identically whether it arrives as a Create or an Update.
 */
async function assembleFederatedNoteContent(
  object: Record<string, unknown>,
  ownerOxyUserId: string | null | undefined,
  ctx: BuildFederatedNoteContentContext,
): Promise<BuiltFederatedNoteContent> {
  const primaryHtml = extractApContentHtml(object);
  const rawText = htmlToPlainText(primaryHtml);

  // Run the centralized hashtag normalizer on every path so an all-hashtag post
  // is stored identically regardless of how it was ingested. `extractApHashtags`
  // supplies the AP `tag` array so non-inline federated tags survive.
  const { content: normalizedText, hashtags } = normalizePostHashtags(rawText, extractApHashtags(object));

  const extracted = extractApMedia(object);
  const { media, attachments } = await materializeFederatedMedia(
    extracted.media,
    extracted.attachments,
    ownerOxyUserId,
    { activityId: ctx.activityId, actorUri: ctx.actorUri },
  );

  const summary = extractApSummary(object);
  const sensitive = object.sensitive === true;

  // Normalization strips a spammy leading hashtag block to empty. When the post
  // was NOTHING but that block (empty normalized text) yet the original body had
  // visible text and there is no media, keep the raw hashtag text visible rather
  // than blanking an all-hashtag post.
  //
  // `normalizePostHashtags` removes the block but NOT the line breaks around it,
  // so a body that opened with one is left starting with blank lines — which the
  // client renders verbatim. Re-normalizing the result closes that gap; the
  // helper is idempotent, so it is a no-op for a body the removal did not touch.
  let text = normalizeMultilineText(normalizedText);
  if (text.length === 0 && rawText.length > 0 && media.length === 0) {
    text = rawText;
  }

  // The localized bodies — the post's only body storage. `text` is handed in as
  // the primary rendition, so the body the guard/classifier see and the body
  // stored in `variants[0]` are the same string by construction.
  const primaryTag = resolveApPrimaryTag(object, primaryHtml);
  const variants = buildApAuthorVariants(object, primaryTag, text, media.length > 0);

  return { text, media, attachments, hashtags, summary, sensitive, variants };
}

/**
 * Build the storable content of a NEW federated Note (inbox `Create`, outbox
 * backfill, boost/ancestor import), applying the empty-note guard on top of the
 * shared extraction.
 *
 * Returns `{ skip: true }` when the Note carries nothing worth storing — no
 * text, no surviving media/attachments, and no content-warning summary — so the
 * caller drops it instead of persisting a blank post. A content-warning-only
 * post (empty body + non-empty `summary`) is intentionally KEPT: the CW label is
 * meaningful content the frontend renders.
 *
 * Polls are not extracted from AP here (federation does not materialize AP
 * `Question` options into a Mention poll), so the guard does not consider them —
 * a poll note always carries its question in `content`, which the text check
 * already covers.
 */
export async function buildFederatedNoteContent(
  object: Record<string, unknown>,
  ownerOxyUserId: string | null | undefined,
  ctx: BuildFederatedNoteContentContext = {},
): Promise<BuiltFederatedNoteContent | SkippedFederatedNoteContent> {
  const built = await assembleFederatedNoteContent(object, ownerOxyUserId, ctx);

  const hasText = built.text.trim().length > 0;
  if (!hasText && built.media.length === 0 && built.attachments.length === 0 && built.summary === undefined) {
    return { skip: true, reason: 'empty-federated-note' };
  }

  return built;
}

/**
 * Build the storable content of an EDITED federated Note (inbox `Update`) from
 * the same shared extraction, but WITHOUT the empty-note guard: an edit always
 * applies its consistently-extracted fields. Unlike a Create — where an empty
 * Note is dropped rather than stored blank — an Update that legitimately clears
 * the body must be applied to the existing post, never skipped or deleted. The
 * caller writes the returned fields onto the post it already found.
 */
export async function buildFederatedNoteContentForEdit(
  object: Record<string, unknown>,
  ownerOxyUserId: string | null | undefined,
  ctx: BuildFederatedNoteContentContext = {},
): Promise<BuiltFederatedNoteContent> {
  return assembleFederatedNoteContent(object, ownerOxyUserId, ctx);
}
