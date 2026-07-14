import { sameBaseLanguage, toBaseLanguage } from '@mention/shared-types';
import type { PostContent, PostVariantSource } from '@mention/shared-types';
import { CONTENT_LANGUAGES, describeContentLanguage, type ContentLanguage } from '@/constants/contentLanguages';

/**
 * ONE rendition of a post the reader can switch to without asking for it.
 *
 * These are exactly the variants the DTO ships: every AUTHOR rendition, plus the
 * machine translation for the reader's own language when one already exists.
 * Their bodies ride along, so switching between them is instant.
 *
 * This list is NOT a menu of what is possible. ANY language is possible — asking
 * for one is a translate action (see {@link translateTargets}), and whether the
 * server answers it from a cache or from a model is the server's business.
 */
export interface PostLanguageOption {
  tag: string;
  source: PostVariantSource;
  /** The body: shipped with the DTO, or fetched since. */
  text?: string;
}

/**
 * The tag the viewer is currently reading, as decided by the server.
 *
 * `textLang` is what hydration actually served. The post's declared `language` is
 * the fallback for a DTO carrying no multilingual fields at all — never a second
 * opinion about what is on screen.
 */
export function servedLanguageTag(content: PostContent, postLanguage?: string): string | null {
  return content.textLang ?? postLanguage ?? null;
}

/**
 * The renditions this post can be read in right now, in the order the switcher
 * offers them: the author's own first (the server sends the primary first), then
 * anything machine-made that came with the DTO or has been fetched since.
 */
export function buildPostLanguageOptions(
  content: PostContent,
  postLanguage?: string,
  locallyTranslated?: Readonly<Record<string, string>>,
): PostLanguageOption[] {
  const byTag = new Map<string, PostLanguageOption>();

  for (const variant of content.variants ?? []) {
    if (!variant?.tag || typeof variant.text !== 'string' || variant.text.length === 0) continue;
    byTag.set(variant.tag, { tag: variant.tag, source: variant.source ?? 'author', text: variant.text });
  }

  // The body on screen is always an option, and it leads: a post that shipped no
  // variants at all still offers its own language once the reader translates it.
  const served = servedLanguageTag(content, postLanguage);
  if (served && !byTag.has(served)) {
    byTag.set(served, { tag: served, source: 'author', text: content.text });
  }

  for (const [tag, text] of Object.entries(locallyTranslated ?? {})) {
    const existing = byTag.get(tag);
    byTag.set(tag, existing ? { ...existing, text } : { tag, source: 'machine', text });
  }

  return [...byTag.values()];
}

/**
 * The languages the reader can ASK for: the app's language catalog, minus the
 * renditions the post already offers.
 *
 * Deliberately the catalog — never an inventory of the translations that happen
 * to exist. The server takes any valid language tag and decides for itself
 * whether serving it costs a cache read or a model call; a reader must never be
 * shown a shorter menu because a cache is cold.
 */
export function translateTargets(options: readonly PostLanguageOption[]): ContentLanguage[] {
  const present = new Set(options.map((option) => option.tag));
  return CONTENT_LANGUAGES.filter((language) => !present.has(language.tag));
}

/**
 * The option a reader of `language` should be offered, preferring what the
 * AUTHOR wrote over what a machine produced for the same language. Matching is
 * on the base subtag: an `es-MX` reader is offered the author's `es-ES`.
 */
export function findOptionForLanguage(
  options: readonly PostLanguageOption[],
  language: string | undefined,
): PostLanguageOption | null {
  if (!language) return null;
  const matches = options.filter((option) => sameBaseLanguage(option.tag, language));
  return matches.find((option) => option.source === 'author') ?? matches[0] ?? null;
}

/**
 * Whether to machine-translate this post for a reader who has auto-translate on.
 *
 * It must NOT fire when the author already wrote this post in the reader's
 * language — machine-translating a body the author wrote by hand replaces their
 * words with a robot's. The comparison is on the BASE subtag throughout: an
 * `es-MX` reader and an `es-ES` post speak the same language.
 */
export function shouldAutoTranslate(params: {
  content: PostContent;
  postLanguage?: string;
  readerLanguage: string | undefined;
  options: readonly PostLanguageOption[];
}): boolean {
  const { content, postLanguage, readerLanguage, options } = params;
  if (!readerLanguage) return false;
  if (typeof content.text !== 'string' || content.text.trim().length === 0) return false;

  const served = servedLanguageTag(content, postLanguage);
  if (sameBaseLanguage(served, readerLanguage)) return false;

  const authored = options.some(
    (option) => option.source === 'author' && sameBaseLanguage(option.tag, readerLanguage),
  );
  return !authored;
}

/**
 * A language's name, from the app's ONE language catalog — the same endonyms the
 * composer writes under, so a post is read under the name it was written under.
 *
 * A tag the catalog does not list (a federated post may carry any valid tag)
 * falls back to its base language, and then to the tag itself. Showing `es-MX`
 * is honest; inventing a name for it would not be.
 *
 * Deliberately not `Intl.DisplayNames`: Hermes ships only Collator,
 * DateTimeFormat and NumberFormat, so it would read correctly on web and degrade
 * to a raw tag on device.
 */
export function languageLabel(tag: string): string {
  const exact = describeContentLanguage(tag);
  if (exact.nativeName !== tag) return exact.nativeName;

  const base = toBaseLanguage(tag);
  if (base) {
    const baseEntry = describeContentLanguage(base);
    if (baseEntry.nativeName !== base) return baseEntry.nativeName;
  }

  return tag;
}
