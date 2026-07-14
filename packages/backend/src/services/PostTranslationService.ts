import {
  canonicalizeLanguageTag,
  type MediaItem,
  type StoredPostContent,
  type PostContentVariant,
} from '@mention/shared-types';
import { Post } from '../models/Post';
import { config } from '../config';
import { logger } from '../utils/logger';
import { aliaChat } from '../utils/alia';
import { resolveVariant } from './postVariants';

/**
 * Machine translation of a post — the SAME array as the author's own language
 * variants (`content.variants`, `source: 'machine'`), so a reader's language
 * ladder finds an AI rendition exactly the way it finds an authored one, and an
 * author variant always wins over a machine one for the same language.
 *
 * A machine variant NEVER overrides media (a machine does not choose images) and
 * never declares the post's language: it is derived content, so it stays out of
 * `postClassification.languages`, out of federation, and out of the author's
 * signed MTN record. It is a cache that grows on demand — unlike author variants,
 * it is deliberately uncapped.
 *
 * The whole surface is unauthenticated by tier: translation is NOT a premium
 * feature.
 */

const MAX_TEXT_LENGTH = config.posts.maxTextLength;

/**
 * Alia's output budget for a translation, derived from the source length. The
 * ratio is generous (a translation can be longer than its source, and a token is
 * several characters), and the ceiling keeps a long article from asking the model
 * for an out-of-range completion.
 */
const TRANSLATION_TOKENS_PER_CHAR = 3;
const MIN_TRANSLATION_TOKENS = 256;
const MAX_TRANSLATION_TOKENS = 8192;

/** Alia model used for translation: the small, fast one. */
const TRANSLATION_MODEL = 'alia-lite';
const TRANSLATION_TEMPERATURE = 0.1;

/** Key prefix for a media item's localized alt text in a keyed translation batch. */
const ALT_KEY_PREFIX = 'alt:';
const ARTICLE_TITLE_KEY = 'article.title';
const ARTICLE_BODY_KEY = 'article.body';
const ARTICLE_EXCERPT_KEY = 'article.excerpt';

const TRANSLATION_SYSTEM_PROMPT =
  'You are a strict translation engine. You receive text wrapped in <text> tags. '
  + 'Output ONLY the translation — no explanations, no commentary, no extra text. '
  + 'Preserve all formatting, mentions, hashtags, and line breaks exactly.';

const KEYED_TRANSLATION_SYSTEM_PROMPT =
  'You are a strict translation engine. You receive a JSON object whose values are strings to translate. '
  + 'Output ONLY a JSON object with the SAME keys and the translated values. '
  + 'No explanations, no commentary, no markdown fences. '
  + 'Preserve all formatting, mentions, hashtags, and line breaks exactly.';

/** A translation request that is the CALLER's fault (unknown language, empty body). */
export class TranslationRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TranslationRequestError';
  }
}

export interface TranslatedPost {
  /** The translated (or already-known) body for the requested language. */
  text: string;
  /** The canonical BCP-47 tag actually served. */
  tag: string;
  /** True when no model call was made: an author variant or a cached machine one answered. */
  cached: boolean;
}

/**
 * The English display name of a language tag, for the model prompt (`es-ES` →
 * "Spanish (Spain)"). ICU is the authority — there is no hand-maintained
 * allowlist, so any structurally valid tag with a known language can be
 * requested. A tag ICU cannot name (it echoes the input back) is rejected.
 */
function languageDisplayName(tag: string): string | null {
  const displayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
  const name = displayNames.of(tag);
  return name && name !== tag ? name : null;
}

function translationTokenBudget(sourceLength: number): number {
  return Math.min(
    Math.max(sourceLength * TRANSLATION_TOKENS_PER_CHAR, MIN_TRANSLATION_TOKENS),
    MAX_TRANSLATION_TOKENS,
  );
}

class PostTranslationService {
  /**
   * Translate a standalone piece of text — the composer's AI pre-fill, which has
   * no post to attach to. Nothing is persisted: what the author approves in the
   * composer is what gets saved, as an AUTHOR variant.
   */
  async translateDraft(rawText: string, rawTag: string): Promise<{ text: string; tag: string }> {
    const { tag, languageName } = this.resolveTarget(rawTag);

    const text = rawText.trim();
    if (text.length === 0) {
      throw new TranslationRequestError('Nothing to translate', 400);
    }

    const translated = await this.translateBody(text, languageName);
    return { text: translated, tag };
  }

  /**
   * Translate a post into `rawTag` and UPSERT the result as a `source: 'machine'`
   * variant, so every later read of the post in that language is served from the
   * post itself.
   *
   * Reads the existing variants first:
   *  - an AUTHOR variant for that language wins outright and no model is called —
   *    translating text the author already wrote would replace their words with a
   *    machine's;
   *  - a cached machine variant answers unless `force` re-translates.
   *
   * The source is the post's PRIMARY rendition (body, the alt text of its media,
   * and its article when it has one), so the machine variant localizes everything
   * the primary shows — not just the body.
   */
  async translatePost(
    postId: string,
    content: StoredPostContent,
    rawTag: string,
    options: { force?: boolean } = {},
  ): Promise<TranslatedPost> {
    const { tag, languageName } = this.resolveTarget(rawTag);

    const existing = Array.isArray(content.variants) ? content.variants : [];

    // An author variant for this language always wins — never machine-translate
    // over words the author wrote themselves.
    const authored = existing.find(
      (variant) => variant.source === 'author' && variant.tag === tag,
    );
    if (authored) {
      return { text: authored.text, tag, cached: true };
    }

    if (options.force !== true) {
      const cached = existing.find(
        (variant) => variant.source === 'machine' && variant.tag === tag,
      );
      if (cached) {
        return { text: cached.text, tag, cached: true };
      }
    }

    const primary = resolveVariant(content);
    const sourceText = primary.text.trim();
    if (sourceText.length === 0) {
      throw new TranslationRequestError('Post has no text content to translate', 404);
    }

    const body = await this.translateBody(sourceText, languageName);
    const localized = await this.translateLocalizableFields(primary.media, primary.article, languageName);

    const variant: PostContentVariant = {
      tag,
      source: 'machine',
      text: body,
      createdAt: new Date().toISOString(),
      ...(localized.alt ? { alt: localized.alt } : {}),
      ...(localized.article ? { article: localized.article } : {}),
    };

    await this.upsertMachineVariant(postId, tag, variant);

    return { text: body, tag, cached: false };
  }

  /**
   * Canonicalize the requested language and name it for the prompt. Rejects any
   * tag ICU cannot resolve to a language — the ONE gate on which languages are
   * translatable (there is no hand-maintained list, and no count limit: the
   * machine cache grows on demand).
   */
  private resolveTarget(rawTag: unknown): { tag: string; languageName: string } {
    const tag = canonicalizeLanguageTag(rawTag);
    if (!tag) {
      throw new TranslationRequestError('targetLanguage must be a valid BCP-47 language tag', 400);
    }
    const languageName = languageDisplayName(tag);
    if (!languageName) {
      throw new TranslationRequestError(`Unsupported language: ${tag}`, 400);
    }
    return { tag, languageName };
  }

  /** Translate the post body — the hot path, one plain-text completion. */
  private async translateBody(text: string, languageName: string): Promise<string> {
    const source = text.slice(0, MAX_TEXT_LENGTH);
    const translated = await aliaChat(
      [
        { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
        { role: 'user', content: `Translate the following to ${languageName}:\n<text>\n${source}\n</text>` },
      ],
      {
        model: TRANSLATION_MODEL,
        temperature: TRANSLATION_TEMPERATURE,
        maxTokens: translationTokenBudget(source.length),
      },
    );

    const trimmed = translated.trim();
    if (!trimmed) {
      throw new Error('Translation returned empty result');
    }
    return trimmed;
  }

  /**
   * Localize what the body alone does not cover: the alt text of the post's media
   * and its article. Only runs when the post actually has one of them (the vast
   * majority of posts skip it entirely), and is BEST-EFFORT — if the model returns
   * something unparseable, the body translation still stands and the variant is
   * simply saved without the extras.
   */
  private async translateLocalizableFields(
    media: MediaItem[] | undefined,
    article: StoredPostContent['article'],
    languageName: string,
  ): Promise<{ alt?: Record<string, string>; article?: PostContentVariant['article'] }> {
    const fields: Record<string, string> = {};

    for (const item of media ?? []) {
      if (typeof item.alt === 'string' && item.alt.trim().length > 0) {
        fields[`${ALT_KEY_PREFIX}${item.id}`] = item.alt;
      }
    }
    if (article?.title) fields[ARTICLE_TITLE_KEY] = article.title;
    if (article?.body) fields[ARTICLE_BODY_KEY] = article.body.slice(0, MAX_TEXT_LENGTH);
    if (article?.excerpt) fields[ARTICLE_EXCERPT_KEY] = article.excerpt;

    if (Object.keys(fields).length === 0) {
      return {};
    }

    const translated = await this.translateFields(fields, languageName);
    if (!translated) {
      return {};
    }

    const alt: Record<string, string> = {};
    const localizedArticle: NonNullable<PostContentVariant['article']> = {};

    for (const [key, value] of Object.entries(translated)) {
      if (key.startsWith(ALT_KEY_PREFIX)) {
        alt[key.slice(ALT_KEY_PREFIX.length)] = value;
      } else if (key === ARTICLE_TITLE_KEY) {
        localizedArticle.title = value;
      } else if (key === ARTICLE_BODY_KEY) {
        localizedArticle.body = value;
      } else if (key === ARTICLE_EXCERPT_KEY) {
        localizedArticle.excerpt = value;
      }
    }

    return {
      ...(Object.keys(alt).length > 0 ? { alt } : {}),
      ...(Object.keys(localizedArticle).length > 0 ? { article: localizedArticle } : {}),
    };
  }

  /**
   * Translate a keyed set of strings in ONE completion. Returns `null` when the
   * model's answer is not a flat object of strings — the caller degrades to a
   * body-only translation rather than failing the request.
   */
  private async translateFields(
    fields: Record<string, string>,
    languageName: string,
  ): Promise<Record<string, string> | null> {
    const payload = JSON.stringify(fields);
    let answer: string;
    try {
      answer = await aliaChat(
        [
          { role: 'system', content: KEYED_TRANSLATION_SYSTEM_PROMPT },
          { role: 'user', content: `Translate every value to ${languageName}:\n${payload}` },
        ],
        {
          model: TRANSLATION_MODEL,
          temperature: TRANSLATION_TEMPERATURE,
          maxTokens: translationTokenBudget(payload.length),
        },
      );
    } catch (error) {
      logger.warn('PostTranslationService: alt/article translation call failed', error);
      return null;
    }

    return parseKeyedTranslation(answer, fields);
  }

  /**
   * Replace this language's machine variant with the fresh one. Two updates
   * because MongoDB cannot `$pull` and `$push` the same array in a single
   * operation; both are awaited so an immediate re-read of the post already sees
   * the new rendition. Bypasses the document hooks by design: a machine variant
   * cannot change the primary body, the hashtags, or the classification.
   */
  private async upsertMachineVariant(
    postId: string,
    tag: string,
    variant: PostContentVariant,
  ): Promise<void> {
    await Post.updateOne(
      { _id: postId },
      { $pull: { 'content.variants': { tag, source: 'machine' } } },
    );
    await Post.updateOne(
      { _id: postId },
      { $push: { 'content.variants': variant } },
    );
  }
}

/**
 * Parse the model's keyed answer: the outermost JSON object, keeping only the
 * keys that were actually requested and whose values came back as non-empty
 * strings. Anything else is discarded — the model does not get to invent fields.
 */
function parseKeyedTranslation(
  answer: string,
  requested: Record<string, string>,
): Record<string, string> | null {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) {
    logger.warn('PostTranslationService: keyed translation answer was not JSON');
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch (error) {
    logger.warn('PostTranslationService: keyed translation answer failed to parse', error);
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in requested)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      result[key] = trimmed;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export const postTranslationService = new PostTranslationService();
