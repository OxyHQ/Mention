import {
  MAX_AUTHOR_VARIANTS,
  canonicalizeLanguageTag,
  toBaseLanguage,
  toBaseLanguages,
  type MediaItem,
  type PostArticleContent,
  type PostContentVariant,
  type StoredPostContent,
} from '@mention/shared-types';
import { config } from '../config';
import { normalizeAltInput, normalizeMediaItems } from '../utils/mediaInput';

/**
 * Multilingual post content: the ONE place that knows how a localized rendition
 * is chosen and how it inherits from the post's shared content.
 *
 * Storage is NORMALIZED — `content.variants[]` is the only home for a post's
 * text, and `variants[0]` is the primary (the rendition that federates, that is
 * signed onto the chain, and that a reader falls back to). Nothing keeps a second
 * copy of the body: what the API serves as `content.text` is RESOLVED here, per
 * reader, on the way out.
 *
 * THE RULE — **a variant inherits everything it does not override**:
 *  - `media` absent → the variant shows `content.media` (the same images), and
 *    its `alt` map localizes THEIR descriptions.
 *  - `media` present → it REPLACES the media set outright (a different
 *    infographic per language). Each `MediaItem` already carries its own `alt`,
 *    so `alt` + `media` on one variant is INVALID (two sources of truth for one
 *    alt text) and is rejected at the boundary by {@link validateAuthorVariants}.
 *  - `article` absent → the variant shows `content.article`.
 *
 * Media and the article live at the TOP, once, precisely BECAUSE they are usually
 * shared: copying them into every variant would mean a bilingual post whose
 * Spanish alt text was edited silently keeps the stale English copy. "I do not
 * override it" has to mean *it is literally the same image*.
 *
 * Resolution ladder (see {@link resolveViewerTag}): explicit tag → Accept-Language
 * → the viewer's Oxy account locales → the post's primary. Within EVERY step:
 * exact tag → any variant sharing the base subtag → next step. So a reader on
 * `es-MX` sees an `es-ES` post in Spanish; never English when Spanish exists.
 *
 * Author variants always beat machine variants of the same base language: a
 * machine translation must never displace words the author actually wrote.
 */

/** One localized rendition, with THE RULE already applied. */
export interface ResolvedVariant {
  /**
   * The BCP-47 tag actually served. `undefined` when the post has no resolvable
   * language (a body too short to detect, a federated Note that declares none) or
   * no body at all (a boost) — never a guess.
   */
  tag?: string;
  text: string;
  media?: MediaItem[];
  article?: PostArticleContent;
}

export type AuthorVariantValidation =
  | { ok: true; variants: PostContentVariant[] }
  | { ok: false; error: string };

const variantsOf = (content: StoredPostContent): PostContentVariant[] =>
  Array.isArray(content.variants) ? content.variants : [];

/**
 * The post's author-written renditions, PRIMARY FIRST — the stored order IS the
 * authoritative order (`variants[0]` is the primary; machine translations are
 * appended after the author's own).
 */
export function authorVariants(content: StoredPostContent): PostContentVariant[] {
  return variantsOf(content).filter((variant) => variant.source === 'author');
}

/**
 * The post's PRIMARY rendition: its first AUTHOR variant. Everything that needs
 * the primary goes through here — nobody indexes the array by hand, so `variants[0]`
 * being the primary stays a fact of this module rather than an assumption sprinkled
 * across callers.
 */
export function getPrimaryVariant(content: StoredPostContent): PostContentVariant | undefined {
  return authorVariants(content)[0];
}

/**
 * The base subtags a post DECLARES, primary first — what the Stage-A classifier
 * stamps onto `postClassification.languages` (and, through it, the top-level AP
 * `post.language`). Only AUTHOR variants declare a language: a machine
 * translation is derived content and must never widen the post's audience. An
 * untagged variant (no resolvable language) declares nothing.
 */
export function declaredBaseLanguages(content: StoredPostContent): string[] {
  return toBaseLanguages(authorVariants(content).map((variant) => variant.tag)).slice(0, MAX_AUTHOR_VARIANTS);
}

/**
 * The primary variant built from a plain body — how a monolingual post (the API
 * still ACCEPTS `content.text`) and every server-side ingest path get their one
 * rendition.
 *
 * `tag` is whatever the author DECLARED or, failing that, whatever the classifier
 * DETECTED (a bare base code like `es`: the region is unknown and must not be
 * invented). It stays absent when neither knows — an untagged rendition is a real
 * state, and minting a tag from a guess would federate that guess as a
 * declaration. Returns `undefined` for an empty body: a boost has no rendition.
 */
export function buildPrimaryVariant(
  text: string | undefined,
  tag: string | undefined,
): PostContentVariant | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return undefined;
  }
  const canonical = canonicalizeLanguageTag(tag);
  return {
    ...(canonical ? { tag: canonical } : {}),
    source: 'author',
    text,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Stamp the language the classifier DETECTED onto a primary rendition the author
 * left untagged — the same thing that happens to a plain `content.text` body, just
 * arriving through the variant shape. An author who named their languages keeps
 * them untouched; a post whose language nothing could resolve keeps its untagged
 * primary, because "we don't know" is the honest answer and a guess would be
 * federated and signed as a declaration.
 */
export function applyDetectedPrimaryTag(
  variants: PostContentVariant[],
  detected: string | undefined,
): PostContentVariant[] {
  const primary = variants[0];
  if (!primary || primary.tag) return variants;
  const canonical = canonicalizeLanguageTag(detected);
  if (!canonical) return variants;
  return [{ ...primary, tag: canonical }, ...variants.slice(1)];
}

/**
 * The best variant for one requested tag: an AUTHOR variant beats a machine one
 * even when the machine variant is the closer regional match — a translation must
 * never displace the author's own words for the same language. An untagged variant
 * matches nothing (it is only ever reachable as the primary).
 */
function selectVariantForTag(
  variants: PostContentVariant[],
  requestedTag: unknown,
): PostContentVariant | undefined {
  const canonical = canonicalizeLanguageTag(requestedTag);
  if (!canonical) return undefined;
  const base = toBaseLanguage(canonical);

  const byPrecedence: Array<(variant: PostContentVariant) => boolean> = [
    (variant) => variant.source === 'author' && variant.tag === canonical,
    (variant) => variant.source === 'author' && base !== null && toBaseLanguage(variant.tag) === base,
    (variant) => variant.source === 'machine' && variant.tag === canonical,
    (variant) => variant.source === 'machine' && base !== null && toBaseLanguage(variant.tag) === base,
  ];

  for (const matches of byPrecedence) {
    const found = variants.find(matches);
    if (found) return found;
  }
  return undefined;
}

/** Apply the localized `alt` map to the SHARED media set (never mutates it). */
function localizeAlt(media: MediaItem[] | undefined, alt: Record<string, string> | undefined): MediaItem[] | undefined {
  if (!media || !alt) return media;
  return media.map((item) => {
    const localized = alt[item.id];
    return typeof localized === 'string' && localized.length > 0 ? { ...item, alt: localized } : item;
  });
}

/**
 * The tag the viewer should be served, resolved down the ladder. `candidates` is
 * the ordered preference list (explicit request tag, then Accept-Language, then
 * the viewer's Oxy account locales); an empty list — an anonymous reader, a
 * crawler, the OG renderer, MCP — resolves to the primary.
 */
export function resolveViewerTag(candidates: readonly string[], content: StoredPostContent): string | undefined {
  const variants = variantsOf(content);
  for (const candidate of candidates) {
    const match = selectVariantForTag(variants, candidate);
    if (match?.tag) return match.tag;
  }
  return getPrimaryVariant(content)?.tag;
}

/**
 * Resolve ONE rendition of the post for `requestedTag`, applying THE RULE. An
 * absent/unknown tag resolves to the primary; a post with no variants at all
 * resolves to an empty body — which is exactly what a boost has.
 */
export function resolveVariant(content: StoredPostContent, requestedTag?: string): ResolvedVariant {
  const variants = variantsOf(content);
  const chosen =
    (requestedTag !== undefined ? selectVariantForTag(variants, requestedTag) : undefined)
    ?? getPrimaryVariant(content);

  if (!chosen) {
    return { text: '', media: content.media, article: content.article };
  }

  return {
    ...(chosen.tag ? { tag: chosen.tag } : {}),
    text: chosen.text,
    // `media` present REPLACES the set; absent inherits the shared set, whose
    // descriptions the variant's `alt` map localizes.
    media: chosen.media ?? localizeAlt(content.media, chosen.alt),
    // `articleId` is never duplicated onto a variant — it is the same entity, so
    // the localized title/body/excerpt merge over the shared article.
    article: chosen.article ? { ...content.article, ...chosen.article } : content.article,
  };
}

/**
 * The renditions a reader can actually switch to, for the DTO: every AUTHOR
 * variant, plus the machine translation for the language they are being served
 * when one exists (the only machine body the client has any use for).
 *
 * The rest of the machine cache is deliberately NOT advertised: which languages
 * happen to be cached is the server's business, and publishing it would invite
 * clients to treat the cache as the menu of what is translatable — when in fact
 * any language is.
 */
export function readerVariants(
  content: StoredPostContent,
  servedTag: string | undefined,
): PostContentVariant[] {
  const variants = variantsOf(content);
  const authors = variants.filter((variant) => variant.source === 'author');
  const servedMachine = variants.find(
    (variant) => variant.source === 'machine' && variant.tag !== undefined && variant.tag === servedTag,
  );
  return servedMachine ? [...authors, servedMachine] : authors;
}

/**
 * Validate the AUTHOR variants submitted by a client and return them canonical:
 * canonical BCP-47 tags, unique, capped at {@link MAX_AUTHOR_VARIANTS}, each body
 * within the post text limit, and `alt` XOR `media` (never both). ORDER IS
 * PRESERVED — the first variant is the primary, so which language the composer
 * makes primary is simply which tab it sends first.
 *
 * AT MOST ONE variant may be untagged, and it must be the PRIMARY. A language is
 * not always resolvable — a body below the detection threshold ("ok", "+1", a bare
 * URL), or a composer whose author simply never named the language they wrote in —
 * and an untagged primary is the honest representation of "we don't know". A
 * SECOND untagged variant, though, is meaningless: nothing could ever select it,
 * since selection is by language. Every rendition after the primary must name its
 * language.
 *
 * `source` is FORCED to `'author'`: machine variants are server-authored (the
 * translation service), so a client can never inject one — nor claim the author
 * wrote what a machine produced.
 *
 * `sharedMediaIds` are the ids of the post's shared media set: an `alt` map may
 * only localize media that actually exists on the post, which both rejects
 * nonsense keys and bounds the map's size.
 */
export function validateAuthorVariants(raw: unknown, sharedMediaIds: readonly string[]): AuthorVariantValidation {
  if (raw === undefined || raw === null) {
    return { ok: true, variants: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'content.variants must be an array' };
  }
  if (raw.length > MAX_AUTHOR_VARIANTS) {
    return { ok: false, error: `Too many language variants: maximum is ${MAX_AUTHOR_VARIANTS}` };
  }

  const mediaIds = new Set(sharedMediaIds);
  const variants: PostContentVariant[] = [];
  const seenTags = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'Each language variant must be an object' };
    }
    const input = entry as Record<string, unknown>;
    const isPrimary = variants.length === 0;

    // An absent tag is allowed ONLY on the primary (the author never named the
    // language). A tag that was SUPPLIED but is not a valid BCP-47 tag is always a
    // rejection — never silently downgraded to "unknown", which would quietly
    // publish a post with no language at all.
    const declaresTag = input.tag !== undefined && input.tag !== null && input.tag !== '';
    const tag = declaresTag ? canonicalizeLanguageTag(input.tag) : undefined;
    if (declaresTag && !tag) {
      return { ok: false, error: 'Each language variant needs a valid BCP-47 language tag' };
    }
    if (!tag && !isPrimary) {
      return { ok: false, error: 'Only the primary language variant may omit its language tag' };
    }
    if (tag) {
      if (seenTags.has(tag)) {
        return { ok: false, error: `Duplicate language variant: ${tag}` };
      }
      seenTags.add(tag);
    }

    const label = tag ?? 'primary';

    if (typeof input.text !== 'string') {
      return { ok: false, error: `Language variant ${label} needs a text body` };
    }
    if (input.text.length > config.posts.maxTextLength) {
      return {
        ok: false,
        error: `Language variant ${label} exceeds the maximum length of ${config.posts.maxTextLength} characters`,
      };
    }

    const hasAlt = input.alt !== undefined && input.alt !== null;
    const hasMedia = input.media !== undefined && input.media !== null;
    if (hasAlt && hasMedia) {
      return {
        ok: false,
        error: `Language variant ${label} cannot set both alt and media — a replaced media set carries its own alt text`,
      };
    }

    const variant: PostContentVariant = {
      ...(tag ? { tag } : {}),
      source: 'author',
      text: input.text,
      createdAt: new Date().toISOString(),
    };

    if (hasAlt) {
      const altResult = normalizeAltMap(input.alt, mediaIds, label);
      if (!altResult.ok) return altResult;
      if (Object.keys(altResult.alt).length > 0) {
        variant.alt = altResult.alt;
      }
    }

    if (hasMedia) {
      const media = normalizeMediaItems(input.media);
      if (media.length === 0) {
        return { ok: false, error: `Language variant ${label} declares an empty media override` };
      }
      variant.media = media;
    }

    if (input.article !== undefined && input.article !== null) {
      const articleResult = normalizeVariantArticle(input.article, label);
      if (!articleResult.ok) return articleResult;
      variant.article = articleResult.article;
    }

    variants.push(variant);
  }

  return { ok: true, variants };
}

function normalizeAltMap(
  raw: unknown,
  mediaIds: ReadonlySet<string>,
  tag: string,
): { ok: true; alt: Record<string, string> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `Language variant ${tag} has an invalid alt map` };
  }

  const alt: Record<string, string> = {};
  for (const [mediaId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!mediaIds.has(mediaId)) {
      return { ok: false, error: `Language variant ${tag} localizes alt text for unknown media ${mediaId}` };
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `Language variant ${tag} has a non-text alt description` };
    }
    // A localized description is alt text like any other: same rule, same cap as
    // the `alt` on a media item ({@link normalizeAltInput}).
    const normalized = normalizeAltInput(value);
    if (normalized !== undefined) {
      alt[mediaId] = normalized;
    }
  }
  return { ok: true, alt };
}

function normalizeVariantArticle(
  raw: unknown,
  tag: string,
): { ok: true; article: NonNullable<PostContentVariant['article']> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `Language variant ${tag} has an invalid article` };
  }
  const input = raw as Record<string, unknown>;
  const article: NonNullable<PostContentVariant['article']> = {};

  if (typeof input.title === 'string' && input.title.trim().length > 0) {
    article.title = input.title.trim().slice(0, config.posts.maxArticleTitleLength);
  }
  if (typeof input.body === 'string' && input.body.length > 0) {
    if (input.body.length > config.posts.maxTextLength) {
      return {
        ok: false,
        error: `Language variant ${tag} has an article body longer than ${config.posts.maxTextLength} characters`,
      };
    }
    article.body = input.body;
    article.excerpt = input.body.slice(0, config.posts.maxArticleExcerptLength);
  }
  if (typeof input.excerpt === 'string' && input.excerpt.trim().length > 0) {
    article.excerpt = input.excerpt.trim().slice(0, config.posts.maxArticleExcerptLength);
  }

  if (article.title === undefined && article.body === undefined && article.excerpt === undefined) {
    return { ok: false, error: `Language variant ${tag} has an empty article` };
  }
  return { ok: true, article };
}
