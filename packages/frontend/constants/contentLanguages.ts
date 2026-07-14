import { canonicalizeLanguageTag } from '@mention/shared-types';

/**
 * A language an author can WRITE a post in.
 *
 * Content is tagged in BCP-47 because what an author wrote is genuinely
 * regional — `pt-BR` and `pt-PT` are not the same text — while the feed matches
 * readers on the base subtag. This catalog therefore lists a region only where
 * it changes the writing (Portuguese, Chinese script, Spanish for Spain vs
 * Latin America); everywhere else the bare language tag is the honest answer.
 *
 * A tag that is not in this catalog is still perfectly valid (an edited post may
 * carry any canonical tag) — {@link describeContentLanguage} degrades to the tag
 * itself rather than dropping it.
 */
export interface ContentLanguage {
  /** Canonical BCP-47 tag, exactly as it is stored on the post. */
  tag: string;
  /** Endonym: the language's name written in that language. */
  nativeName: string;
  /** English name, so search finds the language without typing the endonym. */
  englishName: string;
}

export const CONTENT_LANGUAGES: readonly ContentLanguage[] = [
  { tag: 'ar', nativeName: 'العربية', englishName: 'Arabic' },
  { tag: 'bn', nativeName: 'বাংলা', englishName: 'Bengali' },
  { tag: 'ca', nativeName: 'Català', englishName: 'Catalan' },
  { tag: 'cs', nativeName: 'Čeština', englishName: 'Czech' },
  { tag: 'da', nativeName: 'Dansk', englishName: 'Danish' },
  { tag: 'de', nativeName: 'Deutsch', englishName: 'German' },
  { tag: 'el', nativeName: 'Ελληνικά', englishName: 'Greek' },
  { tag: 'en', nativeName: 'English', englishName: 'English' },
  { tag: 'es-ES', nativeName: 'Español (España)', englishName: 'Spanish (Spain)' },
  { tag: 'es-419', nativeName: 'Español (Latinoamérica)', englishName: 'Spanish (Latin America)' },
  { tag: 'eu', nativeName: 'Euskara', englishName: 'Basque' },
  { tag: 'fa', nativeName: 'فارسی', englishName: 'Persian' },
  { tag: 'fi', nativeName: 'Suomi', englishName: 'Finnish' },
  { tag: 'fr', nativeName: 'Français', englishName: 'French' },
  { tag: 'gl', nativeName: 'Galego', englishName: 'Galician' },
  { tag: 'he', nativeName: 'עברית', englishName: 'Hebrew' },
  { tag: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi' },
  { tag: 'hu', nativeName: 'Magyar', englishName: 'Hungarian' },
  { tag: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian' },
  { tag: 'it', nativeName: 'Italiano', englishName: 'Italian' },
  { tag: 'ja', nativeName: '日本語', englishName: 'Japanese' },
  { tag: 'ko', nativeName: '한국어', englishName: 'Korean' },
  { tag: 'nl', nativeName: 'Nederlands', englishName: 'Dutch' },
  { tag: 'no', nativeName: 'Norsk', englishName: 'Norwegian' },
  { tag: 'pl', nativeName: 'Polski', englishName: 'Polish' },
  { tag: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)' },
  { tag: 'pt-PT', nativeName: 'Português (Portugal)', englishName: 'Portuguese (Portugal)' },
  { tag: 'ro', nativeName: 'Română', englishName: 'Romanian' },
  { tag: 'ru', nativeName: 'Русский', englishName: 'Russian' },
  { tag: 'sv', nativeName: 'Svenska', englishName: 'Swedish' },
  { tag: 'th', nativeName: 'ไทย', englishName: 'Thai' },
  { tag: 'tr', nativeName: 'Türkçe', englishName: 'Turkish' },
  { tag: 'uk', nativeName: 'Українська', englishName: 'Ukrainian' },
  { tag: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese' },
  { tag: 'zh-Hans', nativeName: '简体中文', englishName: 'Chinese (Simplified)' },
  { tag: 'zh-Hant', nativeName: '繁體中文', englishName: 'Chinese (Traditional)' },
];

/** The tag used when the app locale resolves to nothing usable. */
export const FALLBACK_CONTENT_LANGUAGE_TAG = 'en';

const BY_TAG = new Map(CONTENT_LANGUAGES.map((language) => [language.tag, language]));

/**
 * The catalog entry for a tag. An unknown-but-valid tag degrades to itself as
 * its own label — a post written in a language we do not list must still be
 * displayed and edited, never silently discarded.
 */
export function describeContentLanguage(tag: string): ContentLanguage {
  const known = BY_TAG.get(tag);
  if (known) return known;
  return { tag, nativeName: tag, englishName: tag };
}

/**
 * The catalog tag closest to a locale, so the composer opens on the language the
 * author is most likely writing in.
 *
 * Tries the exact tag (`pt-BR`), then any catalog entry sharing the base subtag
 * (`pt` → `pt-BR`), then the bare base subtag, and finally English. The app
 * locale is a UI preference, not a declaration — see `hasDeclaredLanguages` in
 * `utils/composeVariants.ts` for why this default alone never reaches the wire.
 */
export function contentLanguageForLocale(locale: string | undefined): string {
  const canonical = canonicalizeLanguageTag(locale);
  if (canonical === null) return FALLBACK_CONTENT_LANGUAGE_TAG;
  if (BY_TAG.has(canonical)) return canonical;

  const base = canonical.split('-')[0].toLowerCase();
  if (BY_TAG.has(base)) return base;

  const sameBase = CONTENT_LANGUAGES.find((language) => language.tag.split('-')[0].toLowerCase() === base);
  if (sameBase) return sameBase.tag;

  return canonical;
}
