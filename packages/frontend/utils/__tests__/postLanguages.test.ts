import type { PostContent } from '@mention/shared-types';
import { CONTENT_LANGUAGES } from '@/constants/contentLanguages';
import {
  buildPostLanguageOptions,
  findOptionForLanguage,
  languageLabel,
  servedLanguageTag,
  shouldAutoTranslate,
  translateTargets,
} from '../postLanguages';

/**
 * The reading side of a multilingual post.
 *
 * The server resolves ONE body per viewer, so these helpers only answer what the
 * server cannot: which renditions came WITH the post, which languages the reader
 * can still ask for, and whether a machine should be allowed anywhere near a body
 * the author already wrote by hand.
 */

/** A post the author wrote in Spanish and English, served here in Spanish. */
const bilingual: PostContent = {
  text: 'Hola mundo',
  textLang: 'es-ES',
  variants: [
    { tag: 'es-ES', source: 'author', text: 'Hola mundo' },
    { tag: 'en', source: 'author', text: 'Hello world' },
  ],
};

/**
 * English, shipped with the machine translation for THIS reader's language —
 * the only machine variant the DTO ever carries.
 */
const englishWithMachineItalian: PostContent = {
  text: 'Hello world',
  textLang: 'en',
  variants: [
    { tag: 'en', source: 'author', text: 'Hello world' },
    { tag: 'it', source: 'machine', text: 'Ciao mondo' },
  ],
};

describe('servedLanguageTag', () => {
  it('is what hydration actually served', () => {
    expect(servedLanguageTag(bilingual)).toBe('es-ES');
  });

  it('falls back to the declared language for a DTO with no multilingual fields', () => {
    expect(servedLanguageTag({ text: 'Hola' }, 'es')).toBe('es');
    expect(servedLanguageTag({ text: 'Hola' })).toBeNull();
  });
});

describe('buildPostLanguageOptions', () => {
  it('offers exactly the renditions the DTO shipped, author first', () => {
    expect(buildPostLanguageOptions(englishWithMachineItalian)).toEqual([
      { tag: 'en', source: 'author', text: 'Hello world' },
      { tag: 'it', source: 'machine', text: 'Ciao mondo' },
    ]);
  });

  it('carries every body inline — switching between them costs no request', () => {
    const options = buildPostLanguageOptions(bilingual);
    expect(options.map((option) => option.text)).toEqual(['Hola mundo', 'Hello world']);
  });

  it('gives a single-rendition post NOTHING to switch to, so no switcher can appear', () => {
    const options = buildPostLanguageOptions({ text: 'Hello', textLang: 'en' });
    expect(options).toHaveLength(1);
  });

  it('adds a body fetched this session, so "back to the original" survives a translation', () => {
    const options = buildPostLanguageOptions({ text: 'Hello', textLang: 'en' }, undefined, {
      'es-ES': 'Hola',
    });
    expect(options).toEqual([
      { tag: 'en', source: 'author', text: 'Hello' },
      { tag: 'es-ES', source: 'machine', text: 'Hola' },
    ]);
  });
});

describe('translateTargets', () => {
  it('offers the whole language catalog — never an inventory of what happens to be cached', () => {
    const targets = translateTargets(buildPostLanguageOptions(englishWithMachineItalian));
    // German has never been translated for this post; it is offered all the same.
    expect(targets.map((language) => language.tag)).toContain('de');
  });

  it('leaves out the renditions the post already has', () => {
    const targets = translateTargets(buildPostLanguageOptions(englishWithMachineItalian));
    expect(targets.map((language) => language.tag)).not.toContain('en');
    expect(targets.map((language) => language.tag)).not.toContain('it');
    expect(targets).toHaveLength(CONTENT_LANGUAGES.length - 2);
  });
});

describe('findOptionForLanguage', () => {
  const options = buildPostLanguageOptions({
    text: 'Hello',
    textLang: 'en-US',
    variants: [
      { tag: 'en-US', source: 'author', text: 'Hello' },
      { tag: 'es-ES', source: 'author', text: 'Hola' },
      { tag: 'es-419', source: 'machine', text: 'Holaaa' },
    ],
  });

  it('matches on the base subtag: an es-MX reader is offered the es-ES rendition', () => {
    expect(findOptionForLanguage(options, 'es-MX')?.tag).toBe('es-ES');
  });

  it('prefers what the author wrote over what a machine produced for the same language', () => {
    expect(findOptionForLanguage(options, 'es')?.source).toBe('author');
  });

  it('is null for a language the post does not speak', () => {
    expect(findOptionForLanguage(options, 'ja-JP')).toBeNull();
  });
});

describe('shouldAutoTranslate', () => {
  const autoTranslate = (content: PostContent, readerLanguage: string, postLanguage?: string) =>
    shouldAutoTranslate({
      content,
      postLanguage,
      readerLanguage,
      options: buildPostLanguageOptions(content, postLanguage),
    });

  it('does NOT fire when the author already wrote this post in the reader’s language', () => {
    // The server served English (no Accept-Language on a cold request), but the
    // author wrote a Spanish rendition. Machine-translating it would replace the
    // author's own words with a robot's.
    const servedInEnglish: PostContent = { ...bilingual, text: 'Hello world', textLang: 'en-US' };
    expect(autoTranslate(servedInEnglish, 'es-MX')).toBe(false);
  });

  it('does NOT fire when the body on screen is already the reader’s language', () => {
    expect(autoTranslate(bilingual, 'es-MX')).toBe(false);
  });

  it('compares on the base subtag: an es-MX reader and an es-ES post are the same language', () => {
    expect(autoTranslate({ text: 'Hola', textLang: 'es-ES' }, 'es-MX')).toBe(false);
  });

  it('fires for a foreign post the author never wrote in the reader’s language', () => {
    expect(autoTranslate(englishWithMachineItalian, 'es-ES')).toBe(true);
  });

  it('fires when the only rendition in the reader’s language is a MACHINE one — showing it is the point', () => {
    expect(autoTranslate(englishWithMachineItalian, 'it-IT')).toBe(true);
  });

  it('never fires on an empty body', () => {
    expect(autoTranslate({ text: '   ', textLang: 'en-US' }, 'es-ES')).toBe(false);
  });
});

describe('languageLabel', () => {
  it('names a language from the app’s one catalog, under its own endonym', () => {
    expect(languageLabel('es-ES')).toBe('Español (España)');
    expect(languageLabel('ja')).toBe('日本語');
  });

  it('falls back to the base language for a regional tag the catalog does not list', () => {
    expect(languageLabel('en-US')).toBe('English');
  });

  it('shows the raw tag rather than inventing a name for it', () => {
    // `es-MX` is a valid tag a federated post can carry, and the catalog lists
    // `es-ES` / `es-419` — neither of which is Mexican Spanish.
    expect(languageLabel('es-MX')).toBe('es-MX');
  });
});
